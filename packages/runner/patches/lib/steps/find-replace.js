/**
 * find_replace step — literal or regex find/replace on JS content.
 *
 * spec fields:
 *   find: string — the text/pattern to find
 *   replace: string — the replacement text
 *   mode: "literal" | "regex" (default "literal")
 *   pad_to_length: boolean — pad replacement with spaces to match find length (default false)
 *   expected_count: number — expected number of replacements (optional, warns if mismatch)
 */

import { findAllOccurrences } from "../diagnostics.js";

export function executeFindReplace(jsContent, step, vars, diag) {
  // Interpolate vars into find and replace
  let find = step.find;
  let replace = step.replace;
  for (const [k, v] of Object.entries(vars)) {
    find = find.replaceAll(`{{${k}}}`, v);
    replace = replace.replaceAll(`{{${k}}}`, v);
  }

  const mode = step.mode || "literal";
  let result = jsContent;
  let count = 0;

  if (mode === "literal") {
    // Pad if requested
    if (step.pad_to_length && replace.length < find.length) {
      replace = replace + " ".repeat(find.length - replace.length);
    }

    while (result.includes(find)) {
      result = result.replace(find, replace);
      count++;
    }
  } else if (mode === "regex") {
    const regex = new RegExp(find, "g");
    const matches = result.match(regex);
    count = matches ? matches.length : 0;
    result = result.replace(regex, replace);
  }

  if (count === 0) {
    const occurrences = findAllOccurrences(jsContent, find.substring(0, 60));
    diag.fail(step.id, "find_replace", `Pattern not found: "${find.substring(0, 80)}"`, {
      matches: occurrences,
    });
    return null;
  }

  if (step.expected_count !== undefined && count !== step.expected_count) {
    diag.fail(step.id, "find_replace",
      `Expected ${step.expected_count} occurrence(s), found ${count}`,
      { matches: findAllOccurrences(jsContent, find.substring(0, 60)) }
    );
    return null;
  }

  diag.success(step.id, "find_replace", `${count} replacement(s)`);
  return result;
}
