/**
 * Manages a pool of OAuth tokens with round-robin assignment and session affinity.
 *
 * Tokens are parsed from a comma-separated env var. Each new session gets the
 * next token in rotation. Once assigned, a session always uses the same token.
 *
 * Token assignments are persisted via the SessionManager (oauth_token_index column).
 * On startup, call `restore()` to reconstruct in-memory state from the DB.
 */
export class TokenPool {
  private tokens: string[];
  private nextIndex = 0;
  private sessionTokens = new Map<string, number>(); // sessionId -> tokenIndex

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

  /**
   * Restore in-memory state from persisted session data.
   * Call this after constructing the pool and initializing the DB.
   */
  restore(activeSessions: { sessionId: string; tokenIndex: number }[], maxTokenIndex?: number): void {
    for (const { sessionId, tokenIndex } of activeSessions) {
      if (tokenIndex < this.tokens.length) {
        this.sessionTokens.set(sessionId, tokenIndex);
      }
    }
    if (maxTokenIndex !== undefined) {
      this.nextIndex = (maxTokenIndex + 1) % this.tokens.length;
    }
  }

  /** Assign a token to a new session (round-robin). Returns { token, tokenIndex }. */
  assign(sessionId: string): { token: string; tokenIndex: number } {
    const tokenIndex = this.nextIndex;
    const token = this.tokens[tokenIndex];
    this.nextIndex = (this.nextIndex + 1) % this.tokens.length;
    this.sessionTokens.set(sessionId, tokenIndex);
    return { token, tokenIndex };
  }

  /** Get the token assigned to an existing session. */
  get(sessionId: string): string | undefined {
    const idx = this.sessionTokens.get(sessionId);
    return idx !== undefined ? this.tokens[idx] : undefined;
  }

  /** Get a token by its pool index. */
  getByIndex(tokenIndex: number): string | undefined {
    return this.tokens[tokenIndex];
  }

  /** Release a session's token assignment. */
  release(sessionId: string): void {
    this.sessionTokens.delete(sessionId);
  }

  /** Count of active sessions per token (for health/debug). */
  usage(): { tokenIndex: number; activeSessions: number }[] {
    const counts = new Map<number, number>();
    for (const idx of this.sessionTokens.values()) {
      counts.set(idx, (counts.get(idx) || 0) + 1);
    }
    return this.tokens.map((_token, i) => ({
      tokenIndex: i,
      activeSessions: counts.get(i) || 0,
    }));
  }
}
