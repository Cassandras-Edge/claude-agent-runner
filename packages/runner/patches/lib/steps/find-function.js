/**
 * find_function step — locate a function by a stable content string inside its body.
 *
 * Instead of relying on minified function names, this step finds a function
 * by searching for a unique string within its body, then walks backwards to
 * find the function declaration and forward to find its closing brace.
 *
 * spec fields:
 *   content_anchor: string — unique text that appears inside the function body
 *   store_name_as: string — var name to store the function name (optional)
 *   store_start_as: string — var name to store the body start offset (after opening {)
 *   store_end_as: string — var name to store the body end offset (before closing })
 *   function_style: "declaration" | "expression" | "arrow" (default "declaration")
 *     - declaration: `function name(...){`
 *     - expression: `name=function(...){` or `name:function(...){`
 *     - arrow: `name=(...) => {` or `name:(...) =>`
 */

import { findAllOccurrences } from "../diagnostics.js";

export function executeFindFunction(jsContent, step, vars, diag) {
  // Interpolate vars into content_anchor
  let anchor = step.content_anchor;
  for (const [k, v] of Object.entries(vars)) {
    anchor = anchor.replaceAll(`{{${k}}}`, v);
  }

  const anchorIdx = jsContent.indexOf(anchor);
  if (anchorIdx === -1) {
    const occurrences = findAllOccurrences(jsContent, anchor.substring(0, 60));
    diag.fail(step.id, "find_function", `Content anchor not found: "${anchor.substring(0, 80)}"`, {
      matches: occurrences,
    });
    return null;
  }

  // Check uniqueness
  const secondIdx = jsContent.indexOf(anchor, anchorIdx + 1);
  if (secondIdx !== -1) {
    const occurrences = findAllOccurrences(jsContent, anchor.substring(0, 60));
    diag.fail(step.id, "find_function", `Content anchor is not unique (${occurrences.length} occurrences)`, {
      matches: occurrences,
    });
    return null;
  }

  const style = step.function_style || "declaration";

  // Walk backwards from anchor to find the function start
  let fnStart = -1;
  let fnName = null;

  if (style === "declaration") {
    // Look for `function NAME(` walking backwards
    fnStart = findFunctionDeclBackward(jsContent, anchorIdx);
    if (fnStart !== -1) {
      const match = jsContent.substring(fnStart).match(/^function\s+(\w+)\s*\(/);
      if (match) fnName = match[1];
    }
  } else if (style === "expression") {
    // Look for `NAME=function(` or `NAME:function(`
    fnStart = findFunctionExprBackward(jsContent, anchorIdx);
    if (fnStart !== -1) {
      // The fnStart points to `function`, get name before it
      const before = jsContent.substring(Math.max(0, fnStart - 100), fnStart);
      const match = before.match(/(\w+)\s*[=:]\s*$/);
      if (match) fnName = match[1];
    }
  } else if (style === "arrow") {
    // Look for `=>` before the opening brace
    fnStart = findArrowFnBackward(jsContent, anchorIdx);
  }

  if (fnStart === -1) {
    diag.fail(step.id, "find_function",
      `Could not find ${style} function declaration before content anchor at offset ${anchorIdx}`);
    return null;
  }

  // Find the opening brace
  let braceStart = jsContent.indexOf("{", fnStart);
  if (braceStart === -1 || braceStart > anchorIdx) {
    diag.fail(step.id, "find_function", `Could not find opening brace between function start (${fnStart}) and anchor (${anchorIdx})`);
    return null;
  }

  // Find the matching closing brace using brace counting with string awareness
  const braceEnd = findMatchingBrace(jsContent, braceStart);
  if (braceEnd === -1) {
    diag.fail(step.id, "find_function", `Could not find matching closing brace for opening at offset ${braceStart}`);
    return null;
  }

  // Store results
  const bodyStart = braceStart + 1; // after opening {
  const bodyEnd = braceEnd;         // at closing }

  if (step.store_name_as && fnName) vars[step.store_name_as] = fnName;
  if (step.store_start_as) vars[step.store_start_as] = String(bodyStart);
  if (step.store_end_as) vars[step.store_end_as] = String(bodyEnd);

  const detail = [
    fnName ? `name="${fnName}"` : "anonymous",
    `body: ${bodyStart}..${bodyEnd} (${bodyEnd - bodyStart} chars)`,
  ].join(", ");
  diag.success(step.id, "find_function", detail);

  return jsContent; // find_function doesn't modify content
}

/**
 * Walk backwards from `pos` to find `function NAME(`.
 * Scans up to 500 chars back (function declarations are close to their body).
 */
function findFunctionDeclBackward(content, pos) {
  const searchStart = Math.max(0, pos - 500);
  const region = content.substring(searchStart, pos);

  // Find last occurrence of "function " in the region
  let lastIdx = -1;
  let searchFrom = 0;
  while (true) {
    const idx = region.indexOf("function ", searchFrom);
    if (idx === -1) break;
    lastIdx = idx;
    searchFrom = idx + 1;
  }

  if (lastIdx === -1) return -1;
  return searchStart + lastIdx;
}

/**
 * Walk backwards from `pos` to find `function(` (expression style).
 */
function findFunctionExprBackward(content, pos) {
  const searchStart = Math.max(0, pos - 500);
  const region = content.substring(searchStart, pos);

  let lastIdx = -1;
  let searchFrom = 0;
  while (true) {
    const idx = region.indexOf("function(", searchFrom);
    if (idx === -1) {
      const idx2 = region.indexOf("function (", searchFrom);
      if (idx2 === -1) break;
      lastIdx = idx2;
      searchFrom = idx2 + 1;
      continue;
    }
    lastIdx = idx;
    searchFrom = idx + 1;
  }

  if (lastIdx === -1) return -1;
  return searchStart + lastIdx;
}

/**
 * Walk backwards from `pos` to find `=>`.
 */
function findArrowFnBackward(content, pos) {
  const searchStart = Math.max(0, pos - 500);
  const region = content.substring(searchStart, pos);
  const idx = region.lastIndexOf("=>");
  if (idx === -1) return -1;
  return searchStart + idx;
}

/**
 * Find the matching closing brace for an opening brace at `openPos`.
 * Handles string literals (single, double, template) to avoid counting
 * braces inside strings.
 */
export function findMatchingBrace(content, openPos) {
  if (content[openPos] !== "{") return -1;

  let depth = 0;
  let i = openPos;
  const len = content.length;

  while (i < len) {
    const ch = content[i];

    if (ch === "'" || ch === '"') {
      // Skip string literal
      i = skipStringLiteral(content, i);
      continue;
    }

    if (ch === "`") {
      // Skip template literal (with recursive expression handling)
      i = skipTemplateLiteral(content, i);
      continue;
    }

    if (ch === "/" && i + 1 < len) {
      const next = content[i + 1];
      if (next === "/") {
        // Skip single-line comment
        const nl = content.indexOf("\n", i);
        i = nl === -1 ? len : nl + 1;
        continue;
      }
      if (next === "*") {
        // Skip multi-line comment
        const end = content.indexOf("*/", i + 2);
        i = end === -1 ? len : end + 2;
        continue;
      }
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }

    i++;
  }

  return -1;
}

/** Skip a single or double quoted string literal, return position after closing quote. */
function skipStringLiteral(content, pos) {
  const quote = content[pos];
  let i = pos + 1;
  while (i < content.length) {
    if (content[i] === "\\") { i += 2; continue; }
    if (content[i] === quote) return i + 1;
    i++;
  }
  return content.length;
}

/** Skip a template literal, handling nested ${...} expressions. */
function skipTemplateLiteral(content, pos) {
  let i = pos + 1;
  while (i < content.length) {
    if (content[i] === "\\") { i += 2; continue; }
    if (content[i] === "`") return i + 1;
    if (content[i] === "$" && i + 1 < content.length && content[i + 1] === "{") {
      // Template expression — find matching }
      i += 2;
      let depth = 1;
      while (i < content.length && depth > 0) {
        if (content[i] === "{") depth++;
        else if (content[i] === "}") depth--;
        else if (content[i] === "'" || content[i] === '"') { i = skipStringLiteral(content, i); continue; }
        else if (content[i] === "`") { i = skipTemplateLiteral(content, i); continue; }
        if (depth > 0) i++;
      }
      if (depth === 0) i++; // skip closing }
      continue;
    }
    i++;
  }
  return content.length;
}
