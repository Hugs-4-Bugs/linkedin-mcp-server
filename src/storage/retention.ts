/**
 * Retention sweeper (M7, issue #16; ADR-010 / D-006).
 *
 * Enforces per-data-class TTLs by DELETING expired rows from every
 * persistent store. Data classes (all SQL-side, tenant-neutral):
 *
 *   sessions        — rows whose expires_at has passed (auth artifacts).
 *   api_tokens      — rows revoked or expired beyond grace.
 *   oauth_states    — rows past their expires_at (OAuth CSRF artifacts).
 *   publish_operations — ended operations older than the duplicate window
 *                       (LinkedIn-derived content hashes; ADR-010 48h class
 *                       bounded here by the duplicate window the safety
 *                       ledger actually needs).
 *   audit_log       — rows older than the audit retention horizon.
 *   publish_budgets — rows whose latest hit is older than the window
 *                       (orphaned capacity rows).
 *
 * The sweeper is dialect-portable: comparisons are done with ISO strings
 * bound as parameters (works on TEXT in SQLite and TIMESTAMPTZ in PG;
 * the same pattern the state store uses). It never logs row contents —
 * only counts and the data class names.
 */
import { createLogger } from '../observability/logger.js';
import type { SqlExecutor } from './sqlExecutor.js';

const log = createLogger('storage:retention');

export interface RetentionPolicy {
  /** Auth session TTL — mirrors SESSION_TTL_SECONDS (default 8h). */
  sessionTtlMs: number;
  /** OAuth state TTL — mirrors OAUTH_STATE_TTL_SECONDS (default 10m). */
  oauthStateTtlMs: number;
  /** Publish-op ledger horizon = duplicate window (default 10m). */
  publishOpHorizonMs: number;
  /** Audit log retention (default 90d — compliance horizon, not a
   * LinkedIn-derived data class; holds actor/action identifiers only). */
  auditRetentionMs: number;
  /** Revoked API-token grace before deletion (default 24h). */
  apiTokenRevokedGraceMs: number;
  /** Publish-budget orphan horizon — the daily window (default 24h). */
  budgetWindowMs: number;
  /** Terminal scheduled-post retention (default 90d). Outstanding rows
   * (scheduled/running) are never swept — only terminal history. */
  scheduledPostRetentionMs: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  sessionTtlMs: 28_800_000,
  oauthStateTtlMs: 600_000,
  publishOpHorizonMs: 600_000,
  auditRetentionMs: 90 * 86_400_000,
  apiTokenRevokedGraceMs: 86_400_000,
  budgetWindowMs: 86_400_000,
  /** Issue #28: terminal scheduled_posts (published/failed/cancelled)
   * kept for 90 days for audit/debugging, then swept. Outstanding rows
   * (scheduled/running) are NEVER touched by retention. */
  scheduledPostRetentionMs: 90 * 86_400_000,
};

export interface SweepReport {
  /** Per-class deleted row counts (never contents). */
  readonly deleted: Readonly<Record<string, number>>;
  readonly sweptAt: string;
}

export class RetentionSweeper {
  private readonly policy: RetentionPolicy;

  constructor(
    private readonly exec: SqlExecutor,
    policy: Partial<RetentionPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_RETENTION_POLICY, ...policy };
  }

  /**
   * Run one sweep: delete expired rows per data class. Idempotent; safe to
   * run concurrently (DELETEs are row-scoped; no cross-table coupling).
   */
  async sweep(now: number = Date.now()): Promise<SweepReport> {
    const nowIso = new Date(now).toISOString();
    const deleted: Record<string, number> = {};

    // sessions: past expiry (SQLite TEXT / PG TIMESTAMPTZ both compare with
    // a bound ISO string — the pattern the state store already uses).
    deleted.sessions = await this.exec.execute({
      sql: 'DELETE FROM sessions WHERE expires_at < $1',
      params: [nowIso],
    });

    // api_tokens: revoked past grace, or expires beyond any use.
    deleted.api_tokens = await this.exec.execute({
      sql: 'DELETE FROM api_tokens WHERE revoked_at IS NOT NULL AND revoked_at < $1',
      params: [new Date(now - this.policy.apiTokenRevokedGraceMs).toISOString()],
    });

    // oauth_states: expired CSRF artifacts (belt+suspenders with the
    // opportunistic sweep in the state store's create()).
    deleted.oauth_states = await this.exec.execute({
      sql: 'DELETE FROM oauth_states WHERE expires_at < $1',
      params: [nowIso],
    });

    // publish_operations: ended ops older than the duplicate window.
    deleted.publish_operations = await this.exec.execute({
      sql: 'DELETE FROM publish_operations WHERE ended_at IS NOT NULL AND ended_at < $1',
      params: [new Date(now - this.policy.publishOpHorizonMs).toISOString()],
    });

    // audit_log: past the retention horizon (identifiers only, but bound).
    deleted.audit_log = await this.exec.execute({
      sql: 'DELETE FROM audit_log WHERE created_at < $1',
      params: [new Date(now - this.policy.auditRetentionMs).toISOString()],
    });

    // publish_budgets: capacity rows whose window has fully elapsed. The
    // hits column is JSON with timestamps; delete by updated_at older than
    // the window (updated_at is bumped on every hit, so a row older than
    // one window cannot carry live hits).
    deleted.publish_budgets = await this.exec.execute({
      sql: 'DELETE FROM publish_budgets WHERE updated_at < $1',
      params: [new Date(now - this.policy.budgetWindowMs).toISOString()],
    });

    // scheduled_posts (issue #28): TERMINAL rows only — published,
    // failed or cancelled older than the retention horizon. Outstanding
    // work (scheduled/running) is never deleted by retention.
    deleted.scheduled_posts = await this.exec.execute({
      sql: `DELETE FROM scheduled_posts WHERE status IN ('published', 'failed', 'cancelled') AND updated_at < $1`,
      params: [new Date(now - this.policy.scheduledPostRetentionMs).toISOString()],
    });

    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      log.info('retention sweep deleted expired rows', { ...deleted });
    }
    return { deleted, sweptAt: nowIso };
  }
}

/**
 * Periodic sweeper handle. start() returns a handle whose stop() clears the
 * interval — wired into graceful shutdown by the caller (http-entry).
 */
export class PeriodicSweeper {
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly sweeper: RetentionSweeper,
    private readonly intervalMs: number,
  ) {}

  static start(exec: SqlExecutor, intervalMs: number, policy: Partial<RetentionPolicy>): PeriodicSweeper {
    const handle = new PeriodicSweeper(new RetentionSweeper(exec, policy), intervalMs);
    // initial sweep immediately (boot), then on the interval.
    void handle.sweeper.sweep().catch((err: unknown) => {
      log.warn('initial retention sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    handle.timer = setInterval(
      () => {
        void handle.sweeper.sweep().catch((err: unknown) => {
          log.warn('retention sweep failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
      intervalMs,
    );
    // Don't hold the process open just for the sweeper (unref'd timer).
    handle.timer.unref();
    return handle;
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
