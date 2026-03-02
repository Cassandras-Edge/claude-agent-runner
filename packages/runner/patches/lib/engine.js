/**
 * Patch Engine v2 — step-based patch executor.
 *
 * Each patch spec has an ordered `steps` array. Steps are executed in order,
 * building up a shared VarContext. Pre/post assertions validate the patch.
 *
 * Spec format:
 * {
 *   id, description, target, tested_versions?,
 *   steps: [{ type, id, ...step-specific fields }],
 *   assertions?: { pre: [{present|absent}], post: [{present|absent}] }
 * }
 */

import { DiagnosticCollector } from "./diagnostics.js";
import { executeExtract } from "./steps/extract.js";
import { executeFindReplace } from "./steps/find-replace.js";
import { executeInsertAfter, executeInsertBefore } from "./steps/insert.js";

// Phase 2 step types — loaded lazily
let executeFindFunction, executeReplaceInFunction, executeWrapFunction;

async function loadPhase2Steps() {
  if (!executeFindFunction) {
    const ff = await import("./steps/find-function.js");
    const rif = await import("./steps/replace-in-function.js");
    const wf = await import("./steps/wrap-function.js");
    executeFindFunction = ff.executeFindFunction;
    executeReplaceInFunction = rif.executeReplaceInFunction;
    executeWrapFunction = wf.executeWrapFunction;
  }
}

const STEP_HANDLERS = {
  extract: executeExtract,
  find_replace: executeFindReplace,
  insert_after: executeInsertAfter,
  insert_before: executeInsertBefore,
  // Phase 2 types use lazy loading
  find_function: null,
  replace_in_function: null,
  wrap_function: null,
};

/**
 * Apply a single patch spec to JS content.
 *
 * @param {string} jsContent — the full JS source
 * @param {object} spec — parsed spec with `steps` array
 * @param {object} opts — { cliVersion?: string }
 * @returns {{ content: string, vars: Record<string, string>, diag: DiagnosticCollector }}
 * @throws on assertion failure or step failure
 */
export async function applyPatch(jsContent, spec, opts = {}) {
  const diag = new DiagnosticCollector(spec.id);
  const vars = {};

  // Version warning
  if (opts.cliVersion && spec.tested_versions) {
    const ver = opts.cliVersion.replace(/^.*?(\d+\.\d+\.\d+).*$/, "$1");
    if (!spec.tested_versions.includes(ver)) {
      console.warn(`  WARNING: ${spec.id} tested on [${spec.tested_versions.join(", ")}], running on ${ver}`);
    }
  }

  // Pre-assertions
  if (spec.assertions?.pre) {
    for (const a of spec.assertions.pre) {
      if (a.present && !jsContent.includes(a.present)) {
        throw new Error(`Pre-assertion failed for "${spec.id}": expected "${a.present.substring(0, 60)}" to be present`);
      }
      if (a.absent && jsContent.includes(a.absent)) {
        throw new Error(`Pre-assertion failed for "${spec.id}": expected "${a.absent.substring(0, 60)}" to be absent`);
      }
    }
  }

  // Execute steps
  let content = jsContent;
  for (const step of spec.steps) {
    if (!step.id) step.id = `${step.type}_${spec.steps.indexOf(step)}`;

    let handler = STEP_HANDLERS[step.type];

    // Lazy-load Phase 2 handlers
    if (handler === null && ["find_function", "replace_in_function", "wrap_function"].includes(step.type)) {
      await loadPhase2Steps();
      if (step.type === "find_function") handler = executeFindFunction;
      else if (step.type === "replace_in_function") handler = executeReplaceInFunction;
      else if (step.type === "wrap_function") handler = executeWrapFunction;
    }

    if (handler === undefined) {
      diag.fail(step.id, step.type, `Unknown step type: "${step.type}"`);
      throw new Error(`Patch "${spec.id}" failed at step "${step.id}": unknown type "${step.type}"${diag.report()}`);
    }

    const result = handler(content, step, vars, diag);
    if (result === null) {
      throw new Error(`Patch "${spec.id}" failed at step "${step.id}"${diag.report()}`);
    }
    content = result;
  }

  // Post-assertions
  if (spec.assertions?.post) {
    for (const a of spec.assertions.post) {
      if (a.present && !content.includes(a.present)) {
        throw new Error(`Post-assertion failed for "${spec.id}": expected "${a.present.substring(0, 60)}" to be present`);
      }
      if (a.absent && content.includes(a.absent)) {
        throw new Error(`Post-assertion failed for "${spec.id}": expected "${a.absent.substring(0, 60)}" to be absent`);
      }
    }
  }

  return { content, vars, diag };
}
