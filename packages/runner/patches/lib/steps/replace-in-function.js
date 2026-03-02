/**
 * replace_in_function step — scoped find/replace within function boundaries.
 *
 * spec fields:
 *   function_start: string/number — offset of function body start (after opening {)
 *   function_end: string/number — offset of function body end (before closing })
 *   find: string — text to find within the function body
 *   replace: string — replacement text
 *   mode: "literal" | "regex" (default "literal")
 *   expected_count: number — expected number of replacements (optional)
 */

import { findAllOccurrences } from "../diagnostics.js";

export function executeReplaceInFunction(jsContent, step, vars, diag) {
  // Interpolate vars
  let find = step.find;
  let replace = step.replace;
  for (const [k, v] of Object.entries(vars)) {
    find = find.replaceAll(`{{${k}}}`, v);
    replace = replace.replaceAll(`{{${k}}}`, v);
  }

  // Resolve function boundaries from vars
  let fnStart = step.function_start;
  let fnEnd = step.function_end;
  for (const [k, v] of Object.entries(vars)) {
    if (typeof fnStart === "string") fnStart = fnStart.replaceAll(`{{${k}}}`, v);
    if (typeof fnEnd === "string") fnEnd = fnEnd.replaceAll(`{{${k}}}`, v);
  }
  fnStart = parseInt(fnStart, 10);
  fnEnd = parseInt(fnEnd, 10);

  if (isNaN(fnStart) || isNaN(fnEnd)) {
    diag.fail(step.id, "replace_in_function", `Invalid function boundaries: start=${fnStart}, end=${fnEnd}`);
    return null;
  }

  // Extract function body
  const body = jsContent.substring(fnStart, fnEnd);
  const mode = step.mode || "literal";
  let newBody;
  let count = 0;

  if (mode === "literal") {
    newBody = body;
    while (newBody.includes(find)) {
      newBody = newBody.replace(find, replace);
      count++;
    }
  } else if (mode === "regex") {
    const regex = new RegExp(find, "g");
    const matches = body.match(regex);
    count = matches ? matches.length : 0;
    newBody = body.replace(regex, replace);
  }

  if (count === 0) {
    const occurrences = findAllOccurrences(body, find.substring(0, 60));
    diag.fail(step.id, "replace_in_function",
      `Pattern not found in function body (${fnEnd - fnStart} chars): "${find.substring(0, 80)}"`,
      { matches: occurrences }
    );
    return null;
  }

  if (step.expected_count !== undefined && count !== step.expected_count) {
    diag.fail(step.id, "replace_in_function",
      `Expected ${step.expected_count} occurrence(s), found ${count}`);
    return null;
  }

  const result = jsContent.substring(0, fnStart) + newBody + jsContent.substring(fnEnd);
  diag.success(step.id, "replace_in_function", `${count} replacement(s) in function body`);
  return result;
}
