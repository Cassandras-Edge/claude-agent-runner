import WebSocket from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { randomUUID } from "crypto";

// --- Config from env ---

const SESSION_ID = process.env.RUNNER_SESSION_ID || randomUUID();
const ORCHESTRATOR_URL = process.env.RUNNER_ORCHESTRATOR_URL;
const REPO = process.env.RUNNER_REPO;
const BRANCH = process.env.RUNNER_BRANCH || "main";
const GIT_TOKEN = process.env.RUNNER_GIT_TOKEN;
const MODEL = process.env.RUNNER_MODEL || "sonnet";
const SYSTEM_PROMPT = process.env.RUNNER_SYSTEM_PROMPT;
const MAX_TURNS = parseInt(process.env.RUNNER_MAX_TURNS || "25", 10);
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

function createStderrRingBuffer(maxLines: number) {
  const lines: string[] = [];
  return {
    push(chunk: string): void {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) continue;
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    tail(limit = maxLines): string[] {
      return lines.slice(-Math.max(1, Math.min(limit, maxLines)));
    },
  };
}

function buildZeroEventError(
  reason: string,
  model: string,
  maxTurns: number,
  childEnv: Record<string, string>,
  stderrTail: string[],
): string {
  return JSON.stringify(
    {
      code: "claude_cli_no_events",
      reason,
      model,
      maxTurns,
      cwd: WORKSPACE,
      childEnvKeys: Object.keys(childEnv).sort(),
      stderrTail,
    },
    null,
    2,
  );
}

// --- Agent runner ---

let sessionId: string | undefined;

async function runAgent(ws: WebSocket, message: string, overrides?: { model?: string; maxTurns?: number }): Promise<void> {
  const model = overrides?.model || MODEL;
  const maxTurns = overrides?.maxTurns || MAX_TURNS;
  const childEnv = buildClaudeChildEnv();
  const stderrRing = createStderrRingBuffer(200);

  const response = query({
    prompt: message,
    options: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns,
      cwd: WORKSPACE,
      includePartialMessages: true,
      persistSession: true,
      ...(sessionId ? { resume: sessionId } : {}),
      settingSources: [],
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

        // Capture session ID from first message
        if (!sessionId && "session_id" in event && event.session_id) {
          sessionId = event.session_id;
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
          childEnv,
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
        childEnv,
        stderrRing.tail(80),
      ));
    }

    console.log(`Total events received: ${eventCount}`);
  } finally {
    clearTimeout(firstEventTimer);
    response.close();
  }
}

function serializeEvent(event: any): any {
  switch (event.type) {
    case "assistant": {
      const content = event.message?.content
        ?.filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("") || "";
      return { type: "assistant", content, uuid: event.uuid };
    }
    case "stream_event": {
      const e = event.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        return { type: "assistant_delta", content: e.delta.text };
      }
      if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta") {
        return { type: "thinking", content: e.delta.thinking };
      }
      return null; // skip other stream events
    }
    case "user": {
      // Tool results
      if (event.tool_use_result) {
        return {
          type: "tool_result",
          tool_use_id: event.tool_use_result.tool_use_id,
          output: event.tool_use_result.output,
        };
      }
      return null;
    }
    case "tool_progress": {
      return {
        type: "tool_progress",
        tool_name: event.tool_name,
        tool_use_id: event.tool_use_id,
        elapsed_time_seconds: event.elapsed_time_seconds,
      };
    }
    case "result": {
      return {
        type: "result",
        subtype: event.subtype,
        result: event.result || "",
        usage: {
          input_tokens: event.usage?.input_tokens || 0,
          output_tokens: event.usage?.output_tokens || 0,
          cost_usd: event.total_cost_usd || 0,
          duration_ms: event.duration_ms || 0,
        },
        ...(event.subtype !== "success" ? { errors: event.errors || [] } : {}),
      };
    }
    default:
      return null;
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
