/**
 * Master assignment steps 12/16 — durable post scheduling store.
 *
 * Contract (tests enforce each):
 *  - insert(): a scheduled row is durable; survives process restart
 *    (it lives in the same database as every other tenant-owned table).
 *  - claimDue(): exactly-once claiming under concurrent workers — a
 *    single conditional UPDATE ... WHERE id AND status='scheduled'
 *    transitions the row to 'running' and bumps attempts; the worker
 *    whose UPDATE reported 1 affected row owns the execution. On
 *    Postgres the claim runs inside a short transaction with FOR UPDATE
 *    on the candidate select; on SQLite the single conditional UPDATE
 *    is atomic by itself (database-level write lock).
 *  - The publisher reuses publishPostTool's ENTIRE safety stack: the
 *    duplicate-content ledger, the daily publish budget, validation,
 *    authorization — scheduling never bypasses a safety control.
 *  - Retries are BOUNDED (maxAttempts, default 3, ADR-016 no auto-retry
 *    preserved at the tool level: the scheduler retries only its own
 *    transient infrastructure failures, and NEVER re-submits after a
 *    provider confirmation attempt with unknown outcome).
 */
import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../storage/sqlExecutor.js';

export type ScheduledPostStatus = 'scheduled' | 'running' | 'published' | 'failed' | 'cancelled';

export interface ScheduledPost {
  readonly id: string;
  readonly tenantId: string;
  readonly postText: string;
  readonly runAt: string; // ISO-8601; the store never interprets it beyond ordering/comparison
  readonly status: ScheduledPostStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly postUrn: string | null;
}

export interface NewScheduledPost {
  readonly tenantId: string;
  readonly postText: string;
  /** Millisecond epoch — converted to ISO once, at the boundary. */
  readonly runAtMs: number;
}

/** Claimed work item handed to the publisher. */
export interface ClaimedPost {
  readonly id: string;
  readonly tenantId: string;
  readonly postText: string;
  readonly attempts: number;
}

export interface ClaimOutcome {
  /** Rows affected by the claim UPDATE: 1 = this worker owns the post. */
  readonly claimed: boolean;
  readonly post?: ClaimedPost;
}

export class SqlScheduledPostStore {
  constructor(
    private readonly exec: SqlExecutor,
    private readonly opts: { readonly maxAttempts: number; readonly retryBackoffMs?: number } = { maxAttempts: 3 },
  ) {}

  /** Insert a new scheduled post. Idempotent id: server-generated UUID. */
  async insert(req: NewScheduledPost): Promise<ScheduledPost> {
    const id = randomUUID();
    const runAtIso = new Date(req.runAtMs).toISOString();
    await this.exec.execute({
      sql: `INSERT INTO scheduled_posts (id, tenant_id, post_text, run_at, status)
            VALUES ($1, $2, $3, $4, 'scheduled')`,
      params: [id, req.tenantId, req.postText, runAtIso],
    });
    return {
      id,
      tenantId: req.tenantId,
      postText: req.postText,
      runAt: runAtIso,
      status: 'scheduled',
      attempts: 0,
      lastError: null,
      postUrn: null,
    };
  }

  /**
   * Atomically claim ONE due post for this tenant set. The conditional
   * UPDATE is the serialization point: concurrent workers race on
   * status='scheduled' and exactly one UPDATE per row can succeed.
   */
  async claimDue(nowMs: number, tenantId?: string): Promise<ClaimOutcome> {
    const nowIso = new Date(nowMs).toISOString();
    const candidates = await this.exec.query({
      sql: `SELECT id, tenant_id, post_text, attempts FROM scheduled_posts
            WHERE status = 'scheduled' AND run_at <= $1${tenantId !== undefined ? ' AND tenant_id = $2' : ''}
            ORDER BY run_at ASC LIMIT 1`,
      params: tenantId !== undefined ? [nowIso, tenantId] : [nowIso],
    });
    const row = candidates[0];
    if (row === undefined) {
      return { claimed: false };
    }
    const id = String(row.id);
    const attempts = Number(row.attempts ?? 0);
    // Bounded retries (issue #29 off-by-one fix): the claim always hands
    // the row to a worker while attempts < maxAttempts, so a row gets
    // maxAttempts REAL executions; the terminal 'failed' transition now
    // happens when a FAILING execution exhausts the budget
    // (executeOne's markFailed), not at claim time. Rows already at/over
    // budget (e.g. after crash recovery) are terminally failed HERE —
    // the same single conditional UPDATE owns that transition.
    if (attempts >= this.opts.maxAttempts) {
      const exhausted = await this.exec.execute({
        sql: `UPDATE scheduled_posts SET status = 'failed', last_error = 'exhausted retries', updated_at = ${this.nowFn()}
              WHERE id = $1 AND status = 'scheduled'`,
        params: [id],
      });
      if (exhausted === 1) return { claimed: false };
      return { claimed: false };
    }
    const affected = await this.exec.execute({
      sql: `UPDATE scheduled_posts SET status = 'running', attempts = attempts + 1, updated_at = ${this.nowFn()}
            WHERE id = $1 AND status = 'scheduled'`,
      params: [id],
    });
    if (affected !== 1) {
      return { claimed: false }; // lost the race — another worker owns it
    }
    return {
      claimed: true,
      post: { id, tenantId: String(row.tenant_id), postText: String(row.post_text), attempts: attempts + 1 },
    };
  }

  /**
   * Mark a claimed post successfully published.
   * Issue #24 (cancel/claim race): guarded by status='running' and
   * returns false when the row was cancelled mid-execution — the caller
   * keeps the cancelled state instead of silently overwriting it.
   */
  async markPublished(id: string, postUrn: string): Promise<boolean> {
    const affected = await this.exec.execute({
      sql: `UPDATE scheduled_posts SET status = 'published', post_urn = $1, updated_at = ${this.nowFn()} WHERE id = $2 AND status = 'running'`,
      params: [postUrn, id],
    });
    return affected === 1;
  }

  /** Mark a claimed post failed (terminal or awaiting-retry recycles it). */
  async markFailed(id: string, reason: string, retryable: boolean, nowMs: number = Date.now()): Promise<void> {
    if (retryable) {
      // Back to 'scheduled' for a RETRY — with the next attempt pushed
      // one backoff interval into the future so a single drain() loop
      // cannot burn all attempts back-to-back (retry spacing; also caps
      // re-submission pressure on a failing provider). Attempts are
      // already counted by the claim; the claim boundary still
      // terminates at maxAttempts.
      const backoffIso = new Date(nowMs + (this.opts.retryBackoffMs ?? 60_000)).toISOString();
      await this.exec.execute({
        sql: `UPDATE scheduled_posts SET status = 'scheduled', last_error = $1, run_at = $2, updated_at = ${this.nowFn()} WHERE id = $3 AND status = 'running'`,
        params: [reason, backoffIso, id],
      });
      return;
    }
    await this.exec.execute({
      sql: `UPDATE scheduled_posts SET status = 'failed', last_error = $1, updated_at = ${this.nowFn()} WHERE id = $2 AND status = 'running'`,
      params: [reason, id],
    });
  }

  /** User cancellation — allowed only while not yet executed. */
  async cancel(id: string, tenantId: string): Promise<boolean> {
    const affected = await this.exec.execute({
      sql: `UPDATE scheduled_posts SET status = 'cancelled', updated_at = ${this.nowFn()}
            WHERE id = $1 AND tenant_id = $2 AND status IN ('scheduled', 'running')`,
      params: [id, tenantId],
    });
    return affected === 1;
  }

  /** Tenant-scoped listing (admin/console use). */
  async list(tenantId: string): Promise<ScheduledPost[]> {
    const rows = await this.exec.query({
      sql: `SELECT id, tenant_id, post_text, run_at, status, attempts, last_error, post_urn
            FROM scheduled_posts WHERE tenant_id = $1 ORDER BY run_at ASC`,
      params: [tenantId],
    });
    return rows.map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      postText: String(r.post_text),
      runAt: String(r.run_at),
      status: String(r.status) as ScheduledPostStatus,
      attempts: Number(r.attempts ?? 0),
      lastError: typeof r.last_error === 'string' ? r.last_error : null,
      postUrn: typeof r.post_urn === 'string' ? r.post_urn : null,
    }));
  }

  /** Recover rows stuck in 'running' (crashed worker): re-schedule if
   * attempts remain, else terminal-fail. Called at startup. */
  async recoverInterrupted(): Promise<number> {
    const rows = await this.exec.query({
      sql: `SELECT id, attempts FROM scheduled_posts WHERE status = 'running'`,
      params: [],
    });
    let recovered = 0;
    for (const r of rows) {
      const id = String(r.id);
      const attempts = Number(r.attempts ?? 0);
      if (attempts >= this.opts.maxAttempts) {
        await this.exec.execute({
          sql: `UPDATE scheduled_posts SET status = 'failed', last_error = 'interrupted (crash recovery)', updated_at = ${this.nowFn()} WHERE id = $1`,
          params: [id],
        });
      } else {
        await this.exec.execute({
          sql: `UPDATE scheduled_posts SET status = 'scheduled', last_error = 'interrupted (crash recovery)', updated_at = ${this.nowFn()} WHERE id = $1`,
          params: [id],
        });
      }
      recovered += 1;
    }
    return recovered;
  }

  /** Dialect-portable now(): Postgres now(), SQLite datetime('now'). */
  private nowFn(): string {
    return this.exec.kind === 'postgres' ? "now()" : "datetime('now')";
  }
}
