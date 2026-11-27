/**
 * Persistent OAuth state store (M5, ADR-018): same create/consume contract
 * as the M2 in-memory store, SQL-backed. Single-use is enforced with an
 * atomic conditional UPDATE (consumed_at IS NULL) — a replayed state finds
 * the row already consumed and fails, under concurrency too.
 */
import { createLogger } from '../../observability/logger.js';
import type { TenantContext } from '../../identity/tenant.js';
import { tenantKey } from '../../identity/tenant.js';
import { StateStoreError } from './stateStore.js';
import type { SqlExecutor } from '../../storage/sqlExecutor.js';

const log = createLogger('auth:state:db');

/** Timestamps in DB are wall-clock ISO; we compare epoch ms via JS. */
function toEpochMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v.endsWith('Z') ? v : `${v}Z`);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === 'number') return v;
  return null;
}

export class SqlOAuthStateStore {
  constructor(
    private readonly exec: SqlExecutor,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Create a fresh state bound to the tenant; sweep expired rows. */
  async create(tenant: TenantContext): Promise<string> {
    const state = (await import('node:crypto')).randomBytes(32).toString('base64url');
    const expires = this.now() + this.ttlMs;
    await this.exec.with(async (tx) => {
      await tx.execute({
        sql: 'DELETE FROM oauth_states WHERE expires_at < $1',
        // store epoch-ms compatible value via parameter; dialects keep TEXT/TS
        params: [new Date(this.now()).toISOString()],
      });
      await tx.execute({
        sql: `INSERT INTO oauth_states (state, tenant_id, redirect_uri, expires_at)
              VALUES ($1, $2, $3, $4)`,
        params: [state, tenantKey(tenant), 'pending', new Date(expires).toISOString()],
      });
    });
    return state;
  }

  /**
   * Validate + atomically consume: the UPDATE affects a row only when the
   * state exists, is unexpired, unconsumed, and tenant-bound. Affected
   * row count 0 = invalid/expired/consumed/tenant-mismatch/replay.
   */
  async consume(state: string, tenant: TenantContext): Promise<void> {
    const rows = await this.exec.query({
      sql: `SELECT tenant_id, expires_at, consumed_at FROM oauth_states WHERE state = $1`,
      params: [state],
    });
    const row = rows[0];
    if (row === undefined) throw new StateStoreError('invalid', 'unknown state parameter');
    if (row.consumed_at !== null && row.consumed_at !== undefined) {
      throw new StateStoreError('consumed', 'state already used (replay blocked)');
    }
    const exp = toEpochMs(row.expires_at);
    if (exp === null || exp <= this.now()) {
      log.warn('expired state consumed', {});
      throw new StateStoreError('expired', 'state expired; restart the connection flow');
    }
    if (String(row.tenant_id) !== tenantKey(tenant)) {
      log.warn('tenant mismatch on state', {});
      throw new StateStoreError('tenant-mismatch', 'state was issued for a different tenant');
    }
    // Atomic single-use: 0 rows affected => a concurrent request already
    // consumed it (race replay defense).
    const n = await this.exec.execute({
      sql: `UPDATE oauth_states SET consumed_at = $2 WHERE state = $1 AND consumed_at IS NULL`,
      params: [state, new Date(this.now()).toISOString()],
    });
    if (n !== 1) {
      throw new StateStoreError('consumed', 'state already used (replay blocked)');
    }
  }
}
