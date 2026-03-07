import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { describe, it, expect, beforeAll } from "vitest";
import { applyPatch } from "../lib/engine.js";

const ROOT = dirname(dirname(import.meta.url.replace("file://", "")));
const PATCHES_DIR = join(ROOT, "patches");
const SNAPSHOT = join(ROOT, "snapshots", "cli-2.1.63.js");

// ── Helpers ──────────────────────────────────────────────────────────────

function loadAllSpecs() {
  const specs = [];
  const dirs = readdirSync(PATCHES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const dir of dirs) {
    const specPath = join(PATCHES_DIR, dir, "spec.json");
    if (!existsSync(specPath)) continue;
    const spec = JSON.parse(readFileSync(specPath, "utf-8"));
    if (spec.disabled) continue;

    // Resolve code_file references
    if (spec.steps) {
      for (const step of spec.steps) {
        if (step.code_file) {
          step.code = readFileSync(join(PATCHES_DIR, dir, step.code_file), "utf-8");
        }
      }
    }
    specs.push(spec);
  }
  return specs;
}

function loadSpec(id) {
  const specPath = join(PATCHES_DIR, id, "spec.json");
  const spec = JSON.parse(readFileSync(specPath, "utf-8"));
  if (spec.steps) {
    for (const step of spec.steps) {
      if (step.code_file) {
        step.code = readFileSync(join(PATCHES_DIR, id, step.code_file), "utf-8");
      }
    }
  }
  return spec;
}

// ── Tests ────────────────────────────────────────────────────────────────

const snapshotExists = existsSync(SNAPSHOT);

describe.skipIf(!snapshotExists)("Patch Engine — output verification against cli-2.1.63", () => {
  let originalJS;

  beforeAll(() => {
    originalJS = readFileSync(SNAPSHOT, "utf-8");
  });

  // ── Full pipeline ───────────────────────────────────────────────────

  describe("full pipeline — all patches apply in sequence", () => {
    let patchedJS;
    let allResults;

    beforeAll(async () => {
      const specs = loadAllSpecs();
      patchedJS = originalJS;
      allResults = {};

      for (const spec of specs) {
        const result = await applyPatch(patchedJS, spec, { cliVersion: "2.1.63" });
        patchedJS = result.content;
        allResults[spec.id] = result;
      }
    });

    it("applies all enabled patches without errors", () => {
      const specs = loadAllSpecs();
      expect(Object.keys(allResults)).toHaveLength(specs.length);
      for (const [id, result] of Object.entries(allResults)) {
        expect(result.diag.hasFailed, `${id} had failures`).toBe(false);
      }
    });

    it("output is larger than input (insertions add code)", () => {
      expect(patchedJS.length).toBeGreaterThan(originalJS.length);
    });

    it("contains all expected patch markers", () => {
      // clear-resume
      expect(patchedJS).toContain("CLAUDIAN PATCH: /clear and /resume");
      // memory-ipc
      expect(patchedJS).toContain("__memIpcStarted");
      expect(patchedJS).toContain("CLAUDIAN PATCH: memory-ipc");
      // mcp-background
      expect(patchedJS).toContain("CLAUDIAN PATCH: mcp-background");
      expect(patchedJS).toContain("run_in_background");
      // compact-instructions
      expect(patchedJS).toContain("RUNNER_COMPACT_INSTRUCTIONS");
      // compact-model-override
      expect(patchedJS).toContain("RUNNER_COMPACT_MODEL");
    });

    it("no-sibling-abort blanks the guard but keeps the method", () => {
      // The guard string should be replaced with spaces
      expect(patchedJS).not.toContain(
        'if(this.hasErrored&&!this.allToolsAreWriteOrEdit())return"sibling_error"'
      );
      // But the method itself should still exist
      expect(patchedJS).toContain("allToolsAreWriteOrEdit");
    });

    it("output is valid JavaScript (no syntax errors in patched regions)", () => {
      // Smoke test: the patched function should still be parseable
      // Extract the compact function and verify it's balanced
      const fnStart = patchedJS.indexOf("RUNNER_COMPACT_INSTRUCTIONS");
      expect(fnStart).toBeGreaterThan(0);

      // Walk backwards to function start
      let funcStart = patchedJS.lastIndexOf("function ", fnStart);
      expect(funcStart).toBeGreaterThan(0);

      // Find opening brace and count to verify balanced
      let braceStart = patchedJS.indexOf("{", funcStart);
      let depth = 0;
      let i = braceStart;
      for (; i < patchedJS.length; i++) {
        if (patchedJS[i] === "{") depth++;
        else if (patchedJS[i] === "}") { depth--; if (depth === 0) break; }
      }
      expect(depth).toBe(0);
    });
  });

  // ── Individual patch output verification ────────────────────────────

  describe("clear-resume", () => {
    let result;

    beforeAll(async () => {
      const spec = loadSpec("clear-resume");
      result = await applyPatch(originalJS, spec, { cliVersion: "2.1.63" });
    });

    it("resolves all expected variables", () => {
      const { vars } = result;
      expect(vars.LOADER_FN).toBeTruthy();
      expect(vars.CMD_VAR).toBeTruthy();
      expect(vars.PROMPT_VAR).toBeTruthy();
      expect(vars.MESSAGES_VAR).toBeTruthy();
      expect(vars.QUEUE_VAR).toBeTruthy();
      expect(vars.SESSION_FN).toBeTruthy();
      expect(vars.UUID_MOD).toBeTruthy();
    });

    it("variables are short minified identifiers (1-4 chars)", () => {
      for (const [name, val] of Object.entries(result.vars)) {
        expect(val.length, `${name}="${val}" too long`).toBeLessThanOrEqual(5);
        expect(val, `${name} should be alphanumeric`).toMatch(/^\w+$/);
      }
    });

    it("injected code references resolved variables", () => {
      const { content, vars } = result;
      // The patch code should contain the resolved MESSAGES_VAR, not the template
      expect(content).toContain(`${vars.MESSAGES_VAR}.length=0`);
      expect(content).toContain(`${vars.QUEUE_VAR}.enqueue(`);
      expect(content).toContain(`session_id:${vars.SESSION_FN}()`);
      expect(content).toContain(`uuid:${vars.UUID_MOD}()`);
    });

    it("inserts after the prompt variable assignment", () => {
      const { content, vars } = result;
      const marker = `let ${vars.PROMPT_VAR}=${vars.CMD_VAR}.value;`;
      const markerIdx = content.indexOf(marker);
      expect(markerIdx).toBeGreaterThan(0);

      // Patch code should appear right after the marker
      const afterMarker = content.substring(markerIdx + marker.length, markerIdx + marker.length + 200);
      expect(afterMarker).toContain("CLAUDIAN PATCH");
    });

    it("handles /clear command — zeroes messages and enqueues success result", () => {
      const { content, vars } = result;
      expect(content).toContain(`_ct.trim()==="/clear"`);
      expect(content).toContain(`${vars.MESSAGES_VAR}.length=0`);
      expect(content).toContain(`result:"Session cleared"`);
    });

    it("handles /resume command — loads session and replaces messages", () => {
      const { content, vars } = result;
      expect(content).toContain(`_ct.trim().startsWith("/resume ")`);
      expect(content).toContain(`await ${vars.LOADER_FN}(`);
      expect(content).toContain(`result:"Resumed session "`);
      expect(content).toContain(`result:"Session not found: "`);
      expect(content).toContain(`result:"Resume error: "`);
    });
  });

  describe("memory-ipc", () => {
    let result;

    beforeAll(async () => {
      const spec = loadSpec("memory-ipc");
      result = await applyPatch(originalJS, spec, { cliVersion: "2.1.63" });
    });

    it("resolves all expected variables", () => {
      for (const name of ["CMD_VAR", "PROMPT_VAR", "MESSAGES_VAR", "QUEUE_VAR", "SESSION_FN"]) {
        expect(result.vars[name], `missing ${name}`).toBeTruthy();
      }
    });

    it("exposes messages on globalThis", () => {
      expect(result.content).toContain(`globalThis.__mm=${result.vars.MESSAGES_VAR}`);
    });

    it("creates IPC server reading CLAUDE_MEM_SOCKET", () => {
      expect(result.content).toContain("process.env.CLAUDE_MEM_SOCKET");
      expect(result.content).toContain("_net.createServer");
    });

    it("supports all IPC commands", () => {
      for (const cmd of ["get_length", "get_messages", "get_roles", "splice", "push", "pop", "clear", "set", "emit", "session_id"]) {
        expect(result.content, `missing cmd: ${cmd}`).toContain(`cmd==="${cmd}"`);
      }
    });

    it("guards against double initialization", () => {
      expect(result.content).toContain("if(!globalThis.__memIpcStarted)");
    });
  });

  describe("mcp-background", () => {
    let result;

    beforeAll(async () => {
      const spec = loadSpec("mcp-background");
      result = await applyPatch(originalJS, spec, { cliVersion: "2.1.63" });
    });

    it("resolves all task helper functions", () => {
      for (const name of ["TASK_ID_FN", "TASK_OBJ_FN", "OUTPUT_PATH_FN", "TASK_REGISTER_FN", "TASK_UPDATE_FN", "MKDIR_FN"]) {
        expect(result.vars[name], `missing ${name}`).toBeTruthy();
      }
    });

    it("resolves MCP region variables", () => {
      for (const name of ["CONN_VAR", "TOOL_VAR", "FILTER_FN"]) {
        expect(result.vars[name], `missing ${name}`).toBeTruthy();
      }
    });

    it("adds run_in_background to MCP tool schemas", () => {
      expect(result.content).toContain("run_in_background:{type:\"boolean\"");
    });

    it("wraps tool call to run in background when requested", () => {
      const { content, vars } = result;
      expect(content).toContain("D.run_in_background===true");
      expect(content).toContain(`${vars.TASK_ID_FN}("local_bash")`);
      expect(content).toContain(`${vars.TASK_REGISTER_FN}(_tk,_sa)`);
    });

    it("writes output to task output file on completion", () => {
      const { content, vars } = result;
      expect(content).toContain(`writeFileSync(${vars.OUTPUT_PATH_FN}(_id),_out)`);
    });

    it("updates task status on success and failure", () => {
      const { content, vars } = result;
      expect(content).toContain(`${vars.TASK_UPDATE_FN}(_id,_sa,function(t){return Object.assign({},t,{status:"completed"`);
      expect(content).toContain(`${vars.TASK_UPDATE_FN}(_id,_sa,function(t){return Object.assign({},t,{status:"failed"`);
    });
  });

  describe("no-sibling-abort", () => {
    let result;

    beforeAll(async () => {
      const spec = loadSpec("no-sibling-abort");
      result = await applyPatch(originalJS, spec, { cliVersion: "2.1.63" });
    });

    it("removes the sibling error guard", () => {
      expect(result.content).not.toContain(
        'if(this.hasErrored&&!this.allToolsAreWriteOrEdit())return"sibling_error"'
      );
    });

    it("replacement is padded to same length (no offset shifts)", () => {
      expect(result.content.length).toBe(originalJS.length);
    });
  });

  describe("compact-instructions", () => {
    let result;

    beforeAll(async () => {
      const spec = loadSpec("compact-instructions");
      result = await applyPatch(originalJS, spec, { cliVersion: "2.1.63" });
    });

    it("injects RUNNER_COMPACT_INSTRUCTIONS env var read", () => {
      expect(result.content).toContain("process.env.RUNNER_COMPACT_INSTRUCTIONS");
    });

    it("supports replace: prefix to swap entire prompt", () => {
      expect(result.content).toContain('_ci.startsWith("replace:")');
      expect(result.content).toContain("return _ci.slice(8)");
    });

    it("merges env instructions with original parameter", () => {
      expect(result.content).toContain("[A,_ci].filter(Boolean)");
      expect(result.content).toContain("Additional Instructions");
    });

    it("patches both compact functions", () => {
      // Both compaction functions should be patched
      const matches = result.content.match(/RUNNER_COMPACT_INSTRUCTIONS/g);
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it("output length increased (replacement is longer than original)", () => {
      expect(result.content.length).toBeGreaterThan(originalJS.length);
    });
  });

  describe("compact-model-override", () => {
    let result;

    beforeAll(async () => {
      const spec = loadSpec("compact-model-override");
      result = await applyPatch(originalJS, spec, { cliVersion: "2.1.63" });
    });

    it("injects RUNNER_COMPACT_MODEL env var override", () => {
      expect(result.content).toContain("process.env.RUNNER_COMPACT_MODEL");
    });

    it("falls back to mainLoopModel when env var is not set", () => {
      expect(result.content).toContain("RUNNER_COMPACT_MODEL)||Y.options.mainLoopModel");
    });

    it("only replaces the model in the hG6 options (not tool search or hooks)", () => {
      // The other two occurrences of Y.options.mainLoopModel should remain unchanged
      const matches = result.content.match(/Y\.options\.mainLoopModel/g);
      // Original has 3 occurrences in the compact area; we replace 1, so 2 bare + 1 wrapped
      expect(matches.length).toBeGreaterThanOrEqual(3);
    });

    it("output length increased (replacement is longer than original)", () => {
      expect(result.content.length).toBeGreaterThan(originalJS.length);
    });
  });

  // ── Patch ordering / interaction ────────────────────────────────────

  describe("patch interactions", () => {
    it("clear-resume and memory-ipc both insert at same marker without conflict", async () => {
      const memSpec = loadSpec("memory-ipc");
      const clearSpec = loadSpec("clear-resume");

      // Apply in sequence (as patch-all.js does: alphabetical order)
      let content = originalJS;
      const r1 = await applyPatch(content, clearSpec, { cliVersion: "2.1.63" });
      content = r1.content;
      const r2 = await applyPatch(content, memSpec, { cliVersion: "2.1.63" });
      content = r2.content;

      // Both patches should be present
      expect(content).toContain("CLAUDIAN PATCH: /clear and /resume");
      expect(content).toContain("CLAUDIAN PATCH: memory-ipc");
      expect(content).toContain("__memIpcStarted");
    });

    it("compact-instructions does not break mcp-background (different regions)", async () => {
      const compactSpec = loadSpec("compact-instructions");
      const mcpSpec = loadSpec("mcp-background");

      let content = originalJS;
      const r1 = await applyPatch(content, compactSpec, { cliVersion: "2.1.63" });
      content = r1.content;
      const r2 = await applyPatch(content, mcpSpec, { cliVersion: "2.1.63" });
      content = r2.content;

      expect(content).toContain("RUNNER_COMPACT_INSTRUCTIONS");
      expect(content).toContain("CLAUDIAN PATCH: mcp-background");
    });
  });

  // ── Assertion checking ──────────────────────────────────────────────

  describe("assertions", () => {
    it("pre-assertion fails if expected string is missing", async () => {
      const spec = {
        id: "test-pre-fail",
        steps: [],
        assertions: { pre: [{ present: "THIS_STRING_DOES_NOT_EXIST_IN_CLI_JS_12345" }] },
      };
      await expect(applyPatch(originalJS, spec)).rejects.toThrow("Pre-assertion failed");
    });

    it("post-assertion fails if expected string is missing after patching", async () => {
      const spec = {
        id: "test-post-fail",
        steps: [],
        assertions: { post: [{ present: "SHOULD_BE_PRESENT_BUT_ISNT" }] },
      };
      await expect(applyPatch(originalJS, spec)).rejects.toThrow("Post-assertion failed");
    });

    it("post-assertion passes when string is present", async () => {
      const spec = {
        id: "test-post-ok",
        steps: [],
        assertions: { post: [{ present: "function" }] },
      };
      const result = await applyPatch(originalJS, spec);
      expect(result.content).toBe(originalJS);
    });
  });

  // ── Diagnostic output ──────────────────────────────────────────────

  describe("diagnostics on failure", () => {
    it("reports which steps succeeded and which failed", async () => {
      const spec = {
        id: "test-diag",
        steps: [
          { type: "extract", id: "good_step", scope: "global", pattern: "function (\\w+)\\(", store_as: "X" },
          { type: "find_replace", id: "bad_step", find: "NONEXISTENT_STRING_xyz123", replace: "foo", mode: "literal" },
        ],
      };
      try {
        await applyPatch(originalJS, spec);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e.message).toContain("[ok]");
        expect(e.message).toContain("good_step");
        expect(e.message).toContain("[FAIL]");
        expect(e.message).toContain("bad_step");
      }
    });
  });
});
