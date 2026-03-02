/**
 * wrap_function step — inject code after opening { and/or before closing }.
 *
 * spec fields:
 *   function_start: string/number — offset of function body start (after opening {)
 *   function_end: string/number — offset of function body end (before closing })
 *   wrapper_before: string — code to inject right after opening { (optional)
 *   wrapper_after: string — code to inject right before closing } (optional)
 */

export function executeWrapFunction(jsContent, step, vars, diag) {
  // Interpolate vars
  let wrapperBefore = step.wrapper_before || "";
  let wrapperAfter = step.wrapper_after || "";
  for (const [k, v] of Object.entries(vars)) {
    wrapperBefore = wrapperBefore.replaceAll(`{{${k}}}`, v);
    wrapperAfter = wrapperAfter.replaceAll(`{{${k}}}`, v);
  }

  // Resolve function boundaries
  let fnStart = step.function_start;
  let fnEnd = step.function_end;
  for (const [k, v] of Object.entries(vars)) {
    if (typeof fnStart === "string") fnStart = fnStart.replaceAll(`{{${k}}}`, v);
    if (typeof fnEnd === "string") fnEnd = fnEnd.replaceAll(`{{${k}}}`, v);
  }
  fnStart = parseInt(fnStart, 10);
  fnEnd = parseInt(fnEnd, 10);

  if (isNaN(fnStart) || isNaN(fnEnd)) {
    diag.fail(step.id, "wrap_function", `Invalid function boundaries: start=${fnStart}, end=${fnEnd}`);
    return null;
  }

  if (!wrapperBefore && !wrapperAfter) {
    diag.fail(step.id, "wrap_function", "Neither wrapper_before nor wrapper_after specified");
    return null;
  }

  let result = jsContent;
  let detail = [];

  // Insert wrapper_after first (since it's at a higher offset, inserting before won't shift it)
  if (wrapperAfter) {
    result = result.substring(0, fnEnd) + wrapperAfter + result.substring(fnEnd);
    detail.push(`${wrapperAfter.length} chars before closing }`);
  }

  // Insert wrapper_before at function body start
  if (wrapperBefore) {
    result = result.substring(0, fnStart) + wrapperBefore + result.substring(fnStart);
    detail.push(`${wrapperBefore.length} chars after opening {`);
  }

  diag.success(step.id, "wrap_function", `Wrapped: ${detail.join(", ")}`);
  return result;
}
