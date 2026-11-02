import { DeadlineRepository, DeadlineKind } from '../database/repositories/deadlineRepository';

export interface TimerHandlers {
  teamcode: (matchId: string, state: string | null) => void;
  ready: (matchId: string, state: string | null) => void;
  match: (matchId: string, state: string | null) => void;
  vote: (matchId: string, state: string | null) => void;
  fault_report: (matchId: string, state: string | null) => void;
}

/**
 * Deadline timer manager. Every deadline is persisted in the database and
 * re-armed on boot, so a bot restart mid-match continues the countdown instead
 * of losing it. A low-frequency sweep catches clock drift and overdue rows.
 */
export class TimerManager {
  private handles = new Map<string, NodeJS.Timeout>();
  private sweep: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private deadlines: DeadlineRepository,
    private handlers: TimerHandlers
  ) {}

  schedule(matchId: string, kind: DeadlineKind, dueAt: string, state: string | null = null): void {
    this.deadlines.upsert(matchId, kind, dueAt, state);
    this.reschedule(matchId, kind, dueAt, state);
  }

  cancel(matchId: string, kind: DeadlineKind): void {
    this.deadlines.delete(matchId, kind);
    this.clearHandle(matchId, kind);
  }

  /** Converts kind name -> handler; returns null for unknown kinds. */
  private handlerFor(kind: string): ((matchId: string, state: string | null) => void) | null {
    switch (kind) {
      case 'teamcode':
        return this.handlers.teamcode;
      case 'ready':
        return this.handlers.ready;
      case 'match':
        return this.handlers.match;
      case 'vote':
        return this.handlers.vote;
      case 'fault_report':
        return this.handlers.fault_report;
      default:
        return null;
    }
  }

  private key(matchId: string, kind: string): string {
    return `${matchId}:${kind}`;
  }

  private reschedule(matchId: string, kind: string, dueAt: string, state: string | null): void {
    this.clearHandle(matchId, kind);
    const handler = this.handlerFor(kind);
    if (!handler) return;

    const delay = Date.parse(dueAt) - Date.now();
    if (delay <= 0) {
      // Due immediately.
      setImmediate(() => this.fire(matchId, kind as DeadlineKind, handler, state));
      return;
    }
    const handle = setTimeout(() => this.fire(matchId, kind as DeadlineKind, handler, state), delay);
    this.handles.set(this.key(matchId, kind), handle);
  }

  private fire(
    matchId: string,
    kind: DeadlineKind,
    handler: (matchId: string, state: string | null) => void,
    state: string | null
  ): void {
    this.clearHandle(matchId, kind);
    if (this.stopping) return;
    // Guard against acting twice on a stale deadline.
    const row = this.deadlines.get(matchId, kind);
    if (!row) return;
    this.deadlines.delete(matchId, kind);
    handler(matchId, state);
  }

  private clearHandle(matchId: string, kind: string): void {
    const key = this.key(matchId, kind);
    const existing = this.handles.get(key);
    if (existing) {
      clearTimeout(existing);
      this.handles.delete(key);
    }
  }

  /** Re-arm all persisted deadlines; fires anything already overdue. */
  recoverAll(): void {
    for (const row of this.deadlines.all()) {
      const handler = this.handlerFor(row.kind);
      if (!handler) continue;
      this.reschedule(row.match_id, row.kind, row.due_at, row.state);
    }
  }

  cancelAllForMatch(matchId: string): void {
    const rows = this.deadlines.allForMatch(matchId);
    for (const row of rows) {
      this.clearHandle(matchId, row.kind);
    }
    this.deadlines.deleteAllForMatch(matchId);
  }

  startSweep(intervalMs = 10_000): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      const now = new Date().toISOString();
      for (const row of this.deadlines.allDue(now)) {
        const handler = this.handlerFor(row.kind);
        if (!handler) continue;
        this.deadlines.delete(row.match_id, row.kind as DeadlineKind);
        this.clearHandle(row.match_id, row.kind);
        handler(row.match_id, row.state);
      }
    }, intervalMs);
  }

  stopSweep(): void {
    if (this.sweep) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
  }

  stop(): void {
    this.stopping = true;
    this.stopSweep();
    for (const handle of this.handles.values()) {
      clearTimeout(handle);
    }
    this.handles.clear();
  }
}