import type { Session, SessionStatus, RunnerEvent, Usage } from "./types.js";

export class SessionManager {
  private sessions = new Map<string, Session>();

  create(id: string, containerId: string, config: {
    repo?: string;
    branch?: string;
    workspace?: string;
    model: string;
    systemPrompt?: string;
    maxTurns: number;
  }): Session {
    const session: Session = {
      id,
      containerId,
      status: "starting",
      repo: config.repo,
      branch: config.branch,
      workspace: config.workspace,
      model: config.model,
      systemPrompt: config.systemPrompt,
      maxTurns: config.maxTurns,
      createdAt: new Date(),
      lastActivity: new Date(),
      messageCount: 0,
      totalUsage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };

    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  updateStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id);
    if (session) {
      session.status = status;
      session.lastActivity = new Date();
    }
  }

  setError(id: string, error: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.status = "error";
      session.lastError = error;
      session.lastActivity = new Date();
    }
  }

  incrementMessages(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.messageCount++;
      session.lastActivity = new Date();
    }
  }

  addUsage(id: string, usage: Usage): void {
    const session = this.sessions.get(id);
    if (session) {
      session.totalUsage.input_tokens += usage.input_tokens;
      session.totalUsage.output_tokens += usage.output_tokens;
      session.totalUsage.cost_usd += usage.cost_usd;
    }
  }

  remove(id: string): Session | undefined {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    return session;
  }

  activeCount(): number {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status !== "stopped" && s.status !== "error"
    ).length;
  }
}
