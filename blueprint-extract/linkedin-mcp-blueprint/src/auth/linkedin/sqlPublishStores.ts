/**
 * Persistent publish operation ledger + budgets (M5, ADR-018/016):
 * same contracts as the M4 in-memory PostOperationStore and TokenBucket
 * registry, SQL-backed so the duplicate window and daily budget survive
 * restarts. Budget hits serialize inside a transaction (read-modify-write)
 * so concurrent publishes cannot exceed the capacity.
 */
import { createLogger } from '../../observability/logger.js';
import { DuplicateOperationError } from './postOperationStore.js';
import type { PublishOutcome } from './postOperationStore.js';
import { fingerprintPostText } from './postOperationStore.js';
import type { SqlExecutor } from '../../storage/sqlExecutor.js';

const log = createLogger('publish:opstore:db');

export class SqlPostOperationStore {
  constructor(
    private readonly exec: SqlExecutor,
    private readonly duplicateWindowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Prune rows whose window elapsed (bounded table). */
  async prune(): Promise<void> {
    await this.exec.execute({
      sql: `DELETE FROM publish_operations WHERE ended_at IS NOT NULL AND ended_at < $1`,
      params: [new Date(this.now() - this.duplicateWindowMs).toISOString()],
    });
  }

  async enter(tenantId: string, text: string): Promise<string> {
    const hash = fingerprintPostText(text);
    await this.exec.with(async (tx) => {
      // Prune first so retries after the window are allowed.
      await tx.execute({
        sql: `DELETE FROM publish_operations WHERE ended_at IS NOT NULL AND ended_at < $1 AND tenant_id = $2`,
        params: [new Date(this.now() - this.duplicateWindowMs).toISOString(), tenantId],
      });
      const rows = await tx.query({
        sql: `SELECT state, ended_at, attempts FROM publish_operations
              WHERE tenant_id = $1 AND content_hash = $2`,
        params: [tenantId, hash],
      });
      const row = rows[0];
      if (row === undefined) {
        await tx.execute({
          sql: `INSERT INTO publish_operations (tenant_id, content_hash, state, attempts, started_at)
                VALUES ($1, $2, 'in-flight', 1, $3)`,
          params: [tenantId, hash, new Date(this.now()).toISOString()],
        });
        return;
      }
      const state = String(row.state);
      const endedAt = row.ended_at;
      const attempts = Number(row.attempts ?? 1);
      if (state === 'in-flight') {
        throw new DuplicateOperationError(
          'in-flight',
          'An identical publish operation is already in progress for this account.',
        );
      }
      const endedMs =
        endedAt instanceof Date
          ? endedAt.getTime()
          : typeof endedAt === 'string'
            ? Date.parse(endedAt.endsWith('Z') ? endedAt : `${endedAt}Z`)
            : null;
      if (endedMs !== null && this.now() - endedMs < this.duplicateWindowMs) {
        if (state === 'ambiguous') {
          throw new DuplicateOperationError(
            'suspect-after-ambiguous',
            'A previous attempt of this exact content timed out after the provider may have accepted it. Verify whether the post exists on LinkedIn before retrying.',
          );
        }
        if (state === 'success') {
          throw new DuplicateOperationError(
            'recent-identical',
            'This exact post content was already published recently.',
          );
        }
      }
      // failure outside the window, or failure inside it: retry allowed,
      // tracked on the same row.
      await tx.execute({
        sql: `UPDATE publish_operations
              SET state = 'in-flight', started_at = $1, ended_at = NULL, attempts = $2
              WHERE tenant_id = $3 AND content_hash = $4`,
        params: [new Date(this.now()).toISOString(), attempts + 1, tenantId, hash],
      });
    });
    return hash;
  }

  async exit(
    tenantId: string,
    hash: string,
    outcome: PublishOutcome,
    postUrn?: string,
  ): Promise<void> {
    const n = await this.exec.execute({
      sql: `UPDATE publish_operations
            SET state = $1, ended_at = $2, post_urn = $3
            WHERE tenant_id = $4 AND content_hash = $5 AND state = 'in-flight'`,
      params: [
        outcome,
        new Date(this.now()).toISOString(),
        postUrn ?? null,
        tenantId,
        hash,
      ],
    });
    if (n === 0) {
      log.warn('exit without matching in-flight row', { tenant: tenantId });
    }
  }

  async stateOf(tenantId: string, hash: string): Promise<string | undefined> {
    const rows = await this.exec.query({
      sql: `SELECT state FROM publish_operations WHERE tenant_id = $1 AND content_hash = $2`,
      params: [tenantId, hash],
    });
    const row = rows[0];
    return row !== undefined ? String(row.state) : undefined;
  }
}

/**
 * Persistent per-tenant fixed-window budget. Rows are read-modify-written
 * inside a transaction; take() is false when the hit list is full.
 * (Capacity/window come from config; the row materializes on first use.)
 */
export class SqlPublishBudget {
  constructor(
    private readonly exec: SqlExecutor,
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async take(tenantId: string): Promise<boolean> {
    return this.exec.with(async (tx) => {
      const rows = await tx.query({
        sql: `SELECT hits FROM publish_budgets WHERE tenant_id = $1`,
        params: [tenantId],
      });
      let hits: number[] = [];
      const row = rows[0];
      if (row !== undefined) {
        try {
          const parsed = JSON.parse(String(row.hits)) as unknown;
          if (Array.isArray(parsed)) {
            hits = parsed.filter((x): x is number => typeof x === 'number');
          }
        } catch {
          hits = []; // corrupt row: fail closed to empty (safer)
        }
      }
      const cutoff = this.now() - this.windowMs;
      hits = hits.filter((t) => t > cutoff);
      if (hits.length >= this.capacity) {
        await tx.execute({
          sql: `INSERT INTO publish_budgets (tenant_id, window_ms, capacity, hits)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (tenant_id) DO UPDATE SET hits = excluded.hits`,
          params: [tenantId, this.windowMs, this.capacity, JSON.stringify(hits)],
        });
        return false;
      }
      hits.push(this.now());
      await tx.execute({
        sql: `INSERT INTO publish_budgets (tenant_id, window_ms, capacity, hits, updated_at)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (tenant_id) DO UPDATE SET hits = excluded.hits, updated_at = excluded.updated_at`,
        params: [tenantId, this.windowMs, this.capacity, JSON.stringify(hits), new Date(this.now()).toISOString()],
      });
      return true;
    });
  }

  async available(tenantId: string): Promise<number> {
    const rows = await this.exec.query({
      sql: `SELECT hits FROM publish_budgets WHERE tenant_id = $1`,
      params: [tenantId],
    });
    const row = rows[0];
    if (row === undefined) return this.capacity;
    try {
      const parsed = JSON.parse(String(row.hits)) as unknown;
      if (!Array.isArray(parsed)) return this.capacity;
      const cutoff = this.now() - this.windowMs;
      const hits = parsed.filter((x): x is number => typeof x === 'number' && x > cutoff);
      return Math.max(0, this.capacity - hits.length);
    } catch {
      return this.capacity;
    }
  }
}
