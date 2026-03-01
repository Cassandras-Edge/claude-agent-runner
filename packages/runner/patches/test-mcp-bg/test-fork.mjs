#!/usr/bin/env node
/**
 * Test whether Bun's runtime survives fork() on Linux.
 *
 * Tests:
 * 1. Basic fork() — child writes to file, parent waits
 * 2. fork() with active setTimeout (event loop)
 * 3. fork() with an active stdio MCP-like pipe
 * 4. fork() with a pending Promise (simulating in-flight tool call)
 */
import { fork as cpFork } from "child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const RESULTS_DIR = "/tmp/fork-test";
mkdirSync(RESULTS_DIR, { recursive: true });

// We can't use posix fork() directly from Node/Bun JS.
// But we CAN test the pattern using a native addon or /proc/self tricks.
// More practically: test if child_process.fork() preserves the state we need.

// Actually, for the BGSAVE pattern, we need POSIX fork(), not child_process.fork().
// Let's test via a small C helper or via Bun's FFI.

const isBun = typeof Bun !== "undefined";
console.log(`Runtime: ${isBun ? "Bun " + Bun.version : "Node " + process.version}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log("");

if (process.platform !== "linux") {
  console.log("SKIP: fork() test requires Linux (run in Docker)");
  console.log("On macOS, fork() in multi-threaded processes is unsafe.");
  process.exit(0);
}

// Test POSIX fork() via Bun FFI or Node native addon
async function testPosixFork() {
  if (isBun) {
    // Bun has FFI built-in
    const { dlopen, FFIType, ptr, CString } = await import("bun:ffi");

    // Load libc
    const libc = dlopen("libc.so.6", {
      fork: { returns: FFIType.i32, args: [] },
      getpid: { returns: FFIType.i32, args: [] },
      waitpid: { returns: FFIType.i32, args: [FFIType.i32, FFIType.ptr, FFIType.i32] },
      _exit: { returns: FFIType.void, args: [FFIType.i32] },
    });

    // --- Test 1: Basic fork ---
    console.log("Test 1: Basic POSIX fork()");
    const resultFile = join(RESULTS_DIR, "fork-basic.txt");

    // Set up some state BEFORE forking
    const preForkState = { counter: 42, message: "hello from parent" };

    const pid = libc.symbols.fork();

    if (pid === 0) {
      // CHILD process
      // Can we access the pre-fork state?
      writeFileSync(resultFile, JSON.stringify({
        child_pid: libc.symbols.getpid(),
        inherited_state: preForkState,
        event_loop: "alive",
        timestamp: Date.now()
      }));
      libc.symbols._exit(0);
    } else if (pid > 0) {
      // PARENT process
      // Wait for child
      const status = new Int32Array(1);
      libc.symbols.waitpid(pid, ptr(status), 0);

      // Read child's output
      if (existsSync(resultFile)) {
        const childResult = JSON.parse(readFileSync(resultFile, "utf-8"));
        console.log("  Child PID:", childResult.child_pid);
        console.log("  Inherited state:", JSON.stringify(childResult.inherited_state));
        console.log("  PASS: Child inherited pre-fork JS state ✓");
      } else {
        console.log("  FAIL: Child didn't write result file ✗");
      }
    } else {
      console.log("  FAIL: fork() returned", pid, "✗");
    }

    // --- Test 2: Fork with active Promise ---
    console.log("\nTest 2: Fork with in-flight Promise");
    const promiseFile = join(RESULTS_DIR, "fork-promise.txt");

    let resolvePromise;
    const pendingPromise = new Promise(r => { resolvePromise = r; });

    // Simulate: a tool call is in-flight (promise pending)
    setTimeout(() => resolvePromise("tool_result_data"), 2000);

    const pid2 = libc.symbols.fork();

    if (pid2 === 0) {
      // CHILD: can we await the pending promise?
      try {
        const result = await pendingPromise;
        writeFileSync(promiseFile, JSON.stringify({
          promise_resolved: true,
          result: result,
          event_loop_works: true
        }));
      } catch (e) {
        writeFileSync(promiseFile, JSON.stringify({
          promise_resolved: false,
          error: String(e)
        }));
      }
      libc.symbols._exit(0);
    } else if (pid2 > 0) {
      // PARENT: wait for child (should take ~2s for the setTimeout)
      const status2 = new Int32Array(1);
      libc.symbols.waitpid(pid2, ptr(status2), 0);

      if (existsSync(promiseFile)) {
        const childResult = JSON.parse(readFileSync(promiseFile, "utf-8"));
        console.log("  Promise resolved in child:", childResult.promise_resolved);
        console.log("  Result:", childResult.result);
        if (childResult.promise_resolved && childResult.event_loop_works) {
          console.log("  PASS: Event loop + Promises survive fork() ✓");
        } else {
          console.log("  FAIL: Promise didn't resolve ✗");
        }
      } else {
        console.log("  FAIL: Child didn't write result ✗");
      }
    }

    // --- Test 3: Fork with setTimeout chain ---
    console.log("\nTest 3: Fork with setTimeout chain");
    const timerFile = join(RESULTS_DIR, "fork-timer.txt");

    let timerCount = 0;
    const timerInterval = setInterval(() => { timerCount++; }, 100);

    // Let some ticks accumulate
    await new Promise(r => setTimeout(r, 500));
    const preCount = timerCount;

    const pid3 = libc.symbols.fork();

    if (pid3 === 0) {
      // CHILD: do timers keep ticking?
      await new Promise(r => setTimeout(r, 500));
      clearInterval(timerInterval);
      writeFileSync(timerFile, JSON.stringify({
        pre_fork_count: preCount,
        post_fork_count: timerCount,
        timers_work: timerCount > preCount
      }));
      libc.symbols._exit(0);
    } else if (pid3 > 0) {
      clearInterval(timerInterval);
      const status3 = new Int32Array(1);
      libc.symbols.waitpid(pid3, ptr(status3), 0);

      if (existsSync(timerFile)) {
        const childResult = JSON.parse(readFileSync(timerFile, "utf-8"));
        console.log("  Pre-fork timer count:", childResult.pre_fork_count);
        console.log("  Post-fork timer count:", childResult.post_fork_count);
        if (childResult.timers_work) {
          console.log("  PASS: setInterval survives fork() ✓");
        } else {
          console.log("  FAIL: Timers stopped ✗");
        }
      }
    }

    console.log("\n=== Summary ===");
    console.log("If all 3 tests pass, Bun's event loop survives POSIX fork()");
    console.log("and the BGSAVE pattern is viable for conversation forking.");

  } else {
    // Node.js — use native addon or skip
    console.log("Node.js detected. POSIX fork() requires native addon.");
    console.log("Testing with child_process.fork() instead (different semantics).");
    console.log("For true POSIX fork(), run this under Bun in Docker.");
  }
}

await testPosixFork();
