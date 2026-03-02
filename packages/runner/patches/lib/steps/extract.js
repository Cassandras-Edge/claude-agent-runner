/**
 * extract step — capture a minified variable name via regex into VarContext.
 *
 * spec fields:
 *   scope: "global" | "region" (default "region")
 *   anchor: string — stable content string to locate region (only for scope="region")
 *   pattern: string — regex with a capture group
 *   capture: number — capture group index (default 1)
 *   store_as: string — variable name to store the captured value
 *   region_before: number — chars before anchor for region (default 5000)
 *   region_after: number — chars after anchor for region (default 25000)
 */

import { extractRegion, findAllOccurrences } from "../diagnostics.js";

export function executeExtract(jsContent, step, vars, diag) {
  const scope = step.scope || "region";
  const capture = step.capture ?? 1;
  const storeAs = step.store_as;

  if (!storeAs) {
    diag.fail(step.id, "extract", "Missing store_as field");
    return null;
  }

  // Interpolate vars into pattern
  let pattern = step.pattern;
  for (const [k, v] of Object.entries(vars)) {
    pattern = pattern.replaceAll(`{{${k}}}`, v);
  }

  let searchContent = jsContent;
  let regionOffset = 0;

  if (scope === "region") {
    if (!step.anchor) {
      diag.fail(step.id, "extract", "scope=region requires an anchor");
      return null;
    }
    const anchorIdx = jsContent.indexOf(step.anchor);
    if (anchorIdx === -1) {
      const occurrences = findAllOccurrences(jsContent, step.anchor.substring(0, 40));
      diag.fail(step.id, "extract", `Anchor not found: "${step.anchor.substring(0, 60)}"`, {
        matches: occurrences,
      });
      return null;
    }
    const before = step.region_before ?? 5000;
    const after = step.region_after ?? 25000;
    regionOffset = Math.max(0, anchorIdx - before);
    const regionEnd = Math.min(jsContent.length, anchorIdx + after);
    searchContent = jsContent.substring(regionOffset, regionEnd);
  }

  const regex = new RegExp(pattern);
  const match = searchContent.match(regex);
  if (!match || match[capture] === undefined) {
    const region = scope === "region" ? extractRegion(jsContent, regionOffset, 0, 400) : null;
    diag.fail(step.id, "extract", `Pattern /${pattern}/ did not match (capture group ${capture})`, {
      ...(region || {}),
    });
    return null;
  }

  vars[storeAs] = match[capture];
  diag.success(step.id, "extract", `${storeAs} = "${match[capture]}"`);
  return jsContent; // extract doesn't modify content
}
