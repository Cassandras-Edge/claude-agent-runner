import WebSocket from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { serializeEvent } from "./serialize.js";
import { createStderrRingBuffer, buildZeroEventError } from "./helpers.js";

// --- Config from env ---

const SESSION_ID = process.env.RUNNER_SESSION_ID || randomUUID();
const ORCHESTRATOR_URL = process.env.RUNNER_ORCHESTRATOR_URL;
const REPO = process.env.RUNNER_REPO;
const BRANCH = process.env.RUNNER_BRANCH || "main";
const GIT_TOKEN = process.env.RUNNER_GIT_TOKEN;
const MODEL = process.env.RUNNER_MODEL || "sonnet";
const SYSTEM_PROMPT = process.env.RUNNER_SYSTEM_PROMPT;
const APPEND_SYSTEM_PROMPT = process.env.RUNNER_APPEND_SYSTEM_PROMPT;
const MAX_TURNS = process.env.RUNNER_MAX_TURNS ? parseInt(process.env.RUNNER_MAX_TURNS, 10) : undefined;
const THINKING = process.env.RUNNER_THINKING === "true";
const ALLOWED_TOOLS: string[] = process.env.RUNNER_ALLOWED_TOOLS
  ? JSON.parse(process.env.RUNNER_ALLOWED_TOOLS)
  : [];
const DISALLOWED_TOOLS: string[] = process.env.RUNNER_DISALLOWED_TOOLS
  ? JSON.parse(process.env.RUNNER_DISALLOWED_TOOLS)
  : [];
const ADDITIONAL_DIRECTORIES: string[] = process.env.RUNNER_ADDITIONAL_DIRECTORIES
  ? JSON.parse(process.env.RUNNER_ADDITIONAL_DIRECTORIES)
  : [];
const COMPACT_INSTRUCTIONS = process.env.RUNNER_COMPACT_INSTRUCTIONS;
const FORK_FROM = process.env.RUNNER_FORK_FROM;
const FORK_AT = process.env.RUNNER_FORK_AT;
const FORK_SESSION = process.env.RUNNER_FORK_SESSION === "true";
const FIRST_EVENT_TIMEOUT_MS = parseInt(process.env.RUNNER_FIRST_EVENT_TIMEOUT_MS || "90000", 10);
const WORKSPACE = "/workspace";

if (!ORCHESTRATOR_URL) {
  console.error("RUNNER_ORCHESTRATOR_URL is required");
  process.exit(1);
}

// --- Git clone ---

function cloneRepo(): void {
  if (!REPO) return;

  let cloneUrl = REPO;
  if (GIT_TOKEN && cloneUrl.startsWith("https://")) {
    // Inject token for private repos: https://x-access-token:TOKEN@github.com/...
    cloneUrl = cloneUrl.replace("https://", `https://x-access-token:${GIT_TOKEN}@`);
  }

  console.log(`Cloning ${REPO} (branch: ${BRANCH}) into ${WORKSPACE}`);
  try {
    execSync(`git clone --branch ${BRANCH} --single-branch --depth 1 ${cloneUrl} ${WORKSPACE}`, {
      stdio: "inherit",
      timeout: 120_000,
    });
    console.log("Clone complete");
  } catch (err) {
    throw new Error(`Git clone failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildClaudeChildEnv(): Record<string, string> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) {
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required for Claude child process");
  }

  return {
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/runner",
    USER: "runner",
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    TERM: "dumb",
  };
}

// --- Agent runner ---

let sessionId: string | undefined;

async function runAgent(ws: WebSocket, message: string, overrides?: { model?: string; maxTurns?: number }): Promise<void> {
  const model = overrides?.model || MODEL;
  const maxTurns = overrides?.maxTurns ?? MAX_TURNS;
  const childEnv = buildClaudeChildEnv();
  const stderrRing = createStderrRingBuffer(200);

  const hooks: Record<string, any[]> = {};
  if (COMPACT_INSTRUCTIONS) {
    hooks.PreCompact = [{
      hooks: [async () => ({
        continue: true,
        systemMessage: COMPACT_INSTRUCTIONS,
      })],
    }];
  }

  const response = query({
    prompt: message,
    options: {
      model,
      ...(SYSTEM_PROMPT ? { systemPrompt: SYSTEM_PROMPT } : {}),
      ...(APPEND_SYSTEM_PROMPT ? { appendSystemPrompt: APPEND_SYSTEM_PROMPT } : {}),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(THINKING ? { maxThinkingTokens: 10000 } : {}),
      ...(ALLOWED_TOOLS.length > 0 ? { tools: ALLOWED_TOOLS } : {}),
      ...(DISALLOWED_TOOLS.length > 0 ? { disallowedTools: DISALLOWED_TOOLS } : {}),
      cwd: WORKSPACE,
      includePartialMessages: true,
      persistSession: true,
      enableFileCheckpointing: true,
      ...((sessionId || FORK_FROM) ? { resume: sessionId || FORK_FROM } : {}),
      ...(FORK_SESSION && !sessionId ? { forkSession: true } : {}),
      ...(FORK_AT && !sessionId ? { resumeSessionAt: FORK_AT } : {}),
      settingSources: ["project"],
      ...(ADDITIONAL_DIRECTORIES.length > 0 ? { additionalDirectories: ADDITIONAL_DIRECTORIES } : {}),
      ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
      env: childEnv,
      stderr: (data: string) => {
        stderrRing.push(data);
        console.error("[SDK stderr]", data);
      },
    },
  });

  console.log(`query() called with model=${model}, maxTurns=${maxTurns}, cwd=${WORKSPACE}`);

  let eventCount = 0;
  let firstEventTimeoutTriggered = false;
  const firstEventTimer = setTimeout(() => {
    firstEventTimeoutTriggered = true;
    console.error(`No SDK events received within ${FIRST_EVENT_TIMEOUT_MS}ms, closing query response`);
    response.close();
  }, FIRST_EVENT_TIMEOUT_MS);

  try {
    try {
      for await (const event of response) {
        if (eventCount === 0) {
          clearTimeout(firstEventTimer);
        }

        eventCount++;

        // Capture session ID from first message and report back to orchestrator
        if (!sessionId && "session_id" in event && event.session_id) {
          sessionId = event.session_id;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "session_init", session_id: SESSION_ID, sdk_session_id: sessionId }));
          }
        }

        // Forward event to orchestrator
        const serialized = serializeEvent(event);
        if (serialized && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "event",
            session_id: SESSION_ID,
            event: serialized,
          }));
        }

        // Stop on result
        if (event.type === "result") {
          break;
        }
      }
    } catch (iterErr) {
      if (firstEventTimeoutTriggered && eventCount === 0) {
        throw new Error(buildZeroEventError(
          "Timed out waiting for first SDK event",
          model,
          maxTurns,
          WORKSPACE,
          Object.keys(childEnv).sort(),
          stderrRing.tail(80),
        ));
      }

      console.error("Error iterating SDK events:", iterErr);
      throw iterErr;
    }

    if (eventCount === 0) {
      const reason = firstEventTimeoutTriggered
        ? "Timed out waiting for first SDK event"
        : "SDK query completed with zero events";
      throw new Error(buildZeroEventError(
        reason,
        model,
        maxTurns,
        WORKSPACE,
        Object.keys(childEnv).sort(),
        stderrRing.tail(80),
      ));
    }

    console.log(`Total events received: ${eventCount}`);
  } finally {
    clearTimeout(firstEventTimer);
    response.close();
  }
}

// --- WebSocket connection to orchestrator ---

function connect(): void {
  console.log(`Connecting to orchestrator at ${ORCHESTRATOR_URL}`);
  const ws = new WebSocket(ORCHESTRATOR_URL!);

  ws.on("open", () => {
    console.log("Connected to orchestrator");

    // Setup phase: clone repo if needed
    try {
      if (REPO) {
        ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "cloning" }));
        cloneRepo();
      }

      if (!existsSync(WORKSPACE)) {
        throw new Error(`Workspace not found at ${WORKSPACE}`);
      }

      ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "ready" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: "error", session_id: SESSION_ID, code: "clone_failed", message }));
      ws.close();
      process.exit(1);
    }
  });

  ws.on("message", async (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "message") {
      console.log(`Received message: ${msg.message?.slice(0, 80)}...`);
      ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "busy" }));

      try {
        console.log("Starting agent...");
        await runAgent(ws, msg.message, { model: msg.model, maxTurns: msg.maxTurns });
        console.log("Agent finished");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({
          type: "event",
          session_id: SESSION_ID,
          event: { type: "result", subtype: "error_during_execution", result: "", errors: [errorMsg], usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, duration_ms: 0 } },
        }));
      }

      ws.send(JSON.stringify({ type: "status", session_id: SESSION_ID, status: "ready" }));
    }

    if (msg.type === "shutdown") {
      console.log("Shutdown requested");
      ws.close();
      process.exit(0);
    }
  });

  ws.on("close", () => {
    console.log("Disconnected from orchestrator");
    // Attempt reconnect after 3s
    setTimeout(connect, 3000);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

// --- Start ---

console.log(`claude-runner starting (session: ${SESSION_ID})`);
connect();
