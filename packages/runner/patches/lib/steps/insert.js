/**
 * insert_after / insert_before step — find a marker string and insert code.
 *
 * spec fields:
 *   marker: string — the text to find
 *   code: string — inline code to insert (or use code_file at load time, stored as code)
 *   expected_marker_count: number — optional, validates marker uniqueness
 */

import { findAllOccurrences } from "../diagnostics.js";

export function executeInsertAfter(jsContent, step, vars, diag) {
  return executeInsert(jsContent, step, vars, diag, "after");
}

export function executeInsertBefore(jsContent, step, vars, diag) {
  return executeInsert(jsContent, step, vars, diag, "before");
}

function executeInsert(jsContent, step, vars, diag, position) {
  const type = position === "after" ? "insert_after" : "insert_before";

  // Interpolate vars into marker and code
  let marker = step.marker;
  let code = step.code || "";
  for (const [k, v] of Object.entries(vars)) {
    marker = marker.replaceAll(`{{${k}}}`, v);
    code = code.replaceAll(`{{${k}}}`, v);
  }

  // Validate marker count
  if (step.expected_marker_count !== undefined) {
    const occurrences = findAllOccurrences(jsContent, marker);
    if (occurrences.length !== step.expected_marker_count) {
      diag.fail(step.id, type,
        `Expected ${step.expected_marker_count} marker occurrence(s), found ${occurrences.length}`,
        { matches: occurrences }
      );
      return null;
    }
  }

  const idx = jsContent.indexOf(marker);
  if (idx === -1) {
    const occurrences = findAllOccurrences(jsContent, marker.substring(0, 60));
    diag.fail(step.id, type, `Marker not found: "${marker.substring(0, 80)}"`, {
      matches: occurrences,
    });
    return null;
  }

  let result;
  if (position === "after") {
    const insertAt = idx + marker.length;
    result = jsContent.substring(0, insertAt) + "\n" + code + "\n" + jsContent.substring(insertAt);
    diag.success(step.id, type, `Inserted ${code.length} chars after offset ${insertAt}`);
  } else {
    result = jsContent.substring(0, idx) + code + "\n" + jsContent.substring(idx);
    diag.success(step.id, type, `Inserted ${code.length} chars before offset ${idx}`);
  }

  return result;
}
