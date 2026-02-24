import { describe, it, expect } from "vitest";
import { TokenPool } from "../token-pool.js";

describe("TokenPool", () => {
  describe("constructor", () => {
    it("parses comma-separated tokens", () => {
      const pool = new TokenPool("tok-a,tok-b,tok-c");
      expect(pool.size).toBe(3);
    });

    it("trims whitespace from tokens", () => {
      const pool = new TokenPool(" tok-a , tok-b ");
      expect(pool.size).toBe(2);
    });

    it("filters out empty tokens", () => {
      const pool = new TokenPool("tok-a,,tok-b,,,");
      expect(pool.size).toBe(2);
    });

    it("works with a single token", () => {
      const pool = new TokenPool("tok-single");
      expect(pool.size).toBe(1);
    });

    it("throws when no valid tokens are provided", () => {
      expect(() => new TokenPool("")).toThrow("No valid OAuth tokens provided");
      expect(() => new TokenPool("  ,  , ")).toThrow("No valid OAuth tokens provided");
    });
  });

  describe("assign", () => {
    it("round-robins across tokens, returning token and index", () => {
      const pool = new TokenPool("tok-a,tok-b,tok-c");

      const t1 = pool.assign("session-1");
      const t2 = pool.assign("session-2");
      const t3 = pool.assign("session-3");
      const t4 = pool.assign("session-4");

      expect(t1).toEqual({ token: "tok-a", tokenIndex: 0 });
      expect(t2).toEqual({ token: "tok-b", tokenIndex: 1 });
      expect(t3).toEqual({ token: "tok-c", tokenIndex: 2 });
      expect(t4).toEqual({ token: "tok-a", tokenIndex: 0 }); // wraps around
    });

    it("returns the same token for a single-token pool", () => {
      const pool = new TokenPool("tok-only");

      expect(pool.assign("s1")).toEqual({ token: "tok-only", tokenIndex: 0 });
      expect(pool.assign("s2")).toEqual({ token: "tok-only", tokenIndex: 0 });
    });
  });

  describe("get", () => {
    it("returns the assigned token for a session", () => {
      const pool = new TokenPool("tok-a,tok-b");
      pool.assign("session-1");

      expect(pool.get("session-1")).toBe("tok-a");
    });

    it("returns undefined for unknown sessions", () => {
      const pool = new TokenPool("tok-a");
      expect(pool.get("unknown")).toBeUndefined();
    });
  });

  describe("getByIndex", () => {
    it("returns the token at a given index", () => {
      const pool = new TokenPool("tok-a,tok-b,tok-c");
      expect(pool.getByIndex(0)).toBe("tok-a");
      expect(pool.getByIndex(1)).toBe("tok-b");
      expect(pool.getByIndex(2)).toBe("tok-c");
    });

    it("returns undefined for out-of-range index", () => {
      const pool = new TokenPool("tok-a");
      expect(pool.getByIndex(5)).toBeUndefined();
    });
  });

  describe("release", () => {
    it("removes the session-token mapping", () => {
      const pool = new TokenPool("tok-a");
      pool.assign("session-1");
      expect(pool.get("session-1")).toBe("tok-a");

      pool.release("session-1");
      expect(pool.get("session-1")).toBeUndefined();
    });

    it("is a no-op for unknown sessions", () => {
      const pool = new TokenPool("tok-a");
      expect(() => pool.release("nonexistent")).not.toThrow();
    });
  });

  describe("usage", () => {
    it("returns per-token active session counts", () => {
      const pool = new TokenPool("tok-a,tok-b");
      pool.assign("s1"); // tok-a (index 0)
      pool.assign("s2"); // tok-b (index 1)
      pool.assign("s3"); // tok-a (index 0)

      const usage = pool.usage();
      expect(usage).toEqual([
        { tokenIndex: 0, activeSessions: 2 },
        { tokenIndex: 1, activeSessions: 1 },
      ]);
    });

    it("returns zeros when no sessions are assigned", () => {
      const pool = new TokenPool("tok-a,tok-b");
      const usage = pool.usage();
      expect(usage).toEqual([
        { tokenIndex: 0, activeSessions: 0 },
        { tokenIndex: 1, activeSessions: 0 },
      ]);
    });

    it("decrements after release", () => {
      const pool = new TokenPool("tok-a");
      pool.assign("s1");
      pool.assign("s2");
      pool.release("s1");

      const usage = pool.usage();
      expect(usage).toEqual([{ tokenIndex: 0, activeSessions: 1 }]);
    });
  });

  describe("restore", () => {
    it("restores session-token mappings from DB state", () => {
      const pool = new TokenPool("tok-a,tok-b,tok-c");
      pool.restore([
        { sessionId: "s1", tokenIndex: 0 },
        { sessionId: "s2", tokenIndex: 2 },
      ]);

      expect(pool.get("s1")).toBe("tok-a");
      expect(pool.get("s2")).toBe("tok-c");
    });

    it("resumes round-robin from maxTokenIndex + 1", () => {
      const pool = new TokenPool("tok-a,tok-b,tok-c");
      pool.restore([], 1); // last used index 1, so next should be 2

      const result = pool.assign("new-session");
      expect(result).toEqual({ token: "tok-c", tokenIndex: 2 });
    });

    it("skips session mappings with out-of-range indices", () => {
      const pool = new TokenPool("tok-a,tok-b");
      pool.restore([{ sessionId: "s1", tokenIndex: 99 }]);

      expect(pool.get("s1")).toBeUndefined();
    });

    it("wraps around when maxTokenIndex is at the end", () => {
      const pool = new TokenPool("tok-a,tok-b,tok-c");
      pool.restore([], 2); // last index was 2, next wraps to 0

      const result = pool.assign("new-session");
      expect(result).toEqual({ token: "tok-a", tokenIndex: 0 });
    });
  });
});
