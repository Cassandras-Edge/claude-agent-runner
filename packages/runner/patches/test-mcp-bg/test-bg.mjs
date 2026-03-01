#!/usr/bin/env node
/**
 * Integration test for mcp-background patch.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const patchedCli = resolve(__dirname, "../dist/cli-patched.js");
const slowServer = resolve(__dirname, "slow-server.mjs");

console.log("Patched CLI:", patchedCli);
console.log("Slow server:", slowServer);
console.log("");

// Unset to allow nested Claude Code
delete process.env.CLAUDECODE;
delete process.env.CLAUDE_CODE_ENTRYPOINT;

const conversation = query({
  prompt: 'Call the mcp__test-slow__slow_lookup tool with query "test" and set run_in_background to true. Then immediately call TaskOutput with the returned task ID (use block=true, timeout=10000). Report the TaskOutput result verbatim.',
  abortSignal: AbortSignal.timeout(120_000),
  options: {
    maxTurns: 5,
    model: "claude-sonnet-4-20250514",
    systemPrompt: "You are a test agent. Follow instructions exactly.",
    pathToClaudeCodeExecutable: patchedCli,
    executable: "bun",
    allowedTools: ["mcp__test-slow__slow_lookup", "TaskOutput"],
    mcpServers: {
      "test-slow": {
        command: "node",
        args: [slowServer]
      }
    }
  }
});

try {
  for await (const event of conversation) {
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text") console.log("[ASSISTANT]", block.text?.substring(0, 500));
        if (block.type === "tool_use") console.log("[TOOL_USE]", block.name, JSON.stringify(block.input)?.substring(0, 300));
      }
    } else if (event.type === "result") {
      console.log("\n=== RESULT ===");
      console.log("Cost: $" + (event.cost_usd ?? 0).toFixed(4));
      console.log("Turns:", event.num_turns);
      console.log("Result:", event.result?.substring(0, 1000));
      const text = event.result || "";
      if (text.includes("task") || text.includes("background")) console.log("PASS: Background task referenced");
      if (text.includes("42") || text.includes("completed")) console.log("PASS: Got MCP result back");
    } else {
      // Log other event types briefly
      if (event.type !== "system") console.log(`[${event.type}]`, JSON.stringify(event).substring(0, 200));
    }
  }
} catch (e) {
  console.error("Error:", e.message);
}
