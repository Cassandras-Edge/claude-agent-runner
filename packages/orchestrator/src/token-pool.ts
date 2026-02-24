/**
 * Manages a pool of OAuth tokens with round-robin assignment and session affinity.
 *
 * Tokens are parsed from a comma-separated env var. Each new session gets the
 * next token in rotation. Once assigned, a session always uses the same token.
 */
export class TokenPool {
  private tokens: string[];
  private nextIndex = 0;
  private sessionTokens = new Map<string, string>(); // sessionId -> token

  constructor(tokenString: string) {
    this.tokens = tokenString
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (this.tokens.length === 0) {
      throw new Error("No valid OAuth tokens provided");
    }
  }

  /** Number of tokens in the pool. */
  get size(): number {
    return this.tokens.length;
  }

  /** Assign a token to a new session (round-robin). */
  assign(sessionId: string): string {
    const token = this.tokens[this.nextIndex % this.tokens.length];
    this.nextIndex = (this.nextIndex + 1) % this.tokens.length;
    this.sessionTokens.set(sessionId, token);
    return token;
  }

  /** Get the token assigned to an existing session. */
  get(sessionId: string): string | undefined {
    return this.sessionTokens.get(sessionId);
  }

  /** Release a session's token assignment. */
  release(sessionId: string): void {
    this.sessionTokens.delete(sessionId);
  }

  /** Count of active sessions per token (for health/debug). */
  usage(): { tokenIndex: number; activeSessions: number }[] {
    const counts = new Map<string, number>();
    for (const token of this.sessionTokens.values()) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    return this.tokens.map((token, i) => ({
      tokenIndex: i,
      activeSessions: counts.get(token) || 0,
    }));
  }
}
