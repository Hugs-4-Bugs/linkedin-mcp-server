/**
 * M9 issues #13/#14 — billing persistence: webhook events, subscriptions,
 * entitlements, usage counters.
 *
 * Same contract duality as the rest of the M5 persistence layer:
 *  - SqlBillingStore: SqlExecutor-backed (Postgres or SQLite), explicit
 *    transactions, FOR UPDATE row locks on Postgres for atomic quota take.
 *  - InMemoryBillingStore: deterministic unit tests (same semantics).
 *
 * The store guarantees (tests enforce each):
 *  - webhook event insert + subscription transition + entitlement update
 *    happen in ONE transaction (applyEvent) — no half-applied webhooks.
 *  - event dedupe is a unique constraint (SQL) / set membership (memory):
 *    duplicate application is a no-op returning 'duplicate'.
 *  - usage take() is atomic under concurrency (FOR UPDATE on Postgres).
 */
import type { SqlExecutor } from '../storage/sqlExecutor.js';
import type { PaymentProviderEvent } from './providerEvents.js';
import {
  applySubscriptionEvent,
  resolveExpiredGrace,
  type EntitlementStatus,
  type SubscriptionRecord,
} from './subscriptionStateMachine.js';

export type ApplyOutcome = 'applied' | 'duplicate';

export interface UsageSnapshot {
  tenantId: string;
  counter: string;
  used: number;
  capacity: number;
}

/** Entitlement + plan limit resolution seam (config-shaped, test-overridable). */
/** Monthly LinkedIn tool-call allowance per plan id. */
export type PlanLimits = Record<string, number>;

/** Common contract both stores satisfy. */
export interface BillingStore {
  /** Persist a verified provider event and apply it atomically. */
  applyEvent(event: PaymentProviderEvent, now: number): Promise<ApplyOutcome>;
  /** Subscription record for a tenant (their current one), or undefined. */
  subscriptionOf(tenantId: string): Promise<SubscriptionRecord | undefined>;
  /** Entitlement status for a tenant (resolved for expiry), or undefined. */
  entitlementOf(tenantId: string, now: number): Promise<SubscriptionRecord | undefined>;
  /** Atomic quota consumption: true = allowed, false = exhausted. */
  take(tenantId: string, counter: string, capacity: number, windowMs: number, now: number): Promise<boolean>;
  /** Usage snapshot for surfaces/tests. */
  usageOf(tenantId: string, counter: string): Promise<UsageSnapshot | undefined>;
}

/** In-memory billing store (deterministic tests; same semantics as SQL). */
export class InMemoryBillingStore implements BillingStore {
  private readonly events = new Set<string>();
  private readonly subs = new Map<string, SubscriptionRecord>();
  private readonly usage = new Map<string, { hits: number[] }>();

  async applyEvent(event: PaymentProviderEvent, now: number): Promise<ApplyOutcome> {
    if (this.events.has(event.eventId)) {
      return await Promise.resolve('duplicate');
    }
    // Record the event id BEFORE applying so the transition itself is
    // idempotent even if apply threw mid-way in a future implementation.
    this.events.add(event.eventId);
    const current = this.subs.get(event.tenantId);
    const next = resolveExpiredGrace(
      applySubscriptionEvent(current, event, now),
      now,
    );
    this.subs.set(event.tenantId, next);
    return await Promise.resolve('applied');
  }

  async subscriptionOf(tenantId: string): Promise<SubscriptionRecord | undefined> {
    return await Promise.resolve(this.subs.get(tenantId));
  }

  async entitlementOf(tenantId: string, now: number): Promise<SubscriptionRecord | undefined> {
    const rec = await this.subscriptionOf(tenantId);
    if (rec === undefined) {
      return undefined;
    }
    return resolveExpiredGrace(rec, now);
  }

  async take(tenantId: string, counter: string, capacity: number, windowMs: number, now: number): Promise<boolean> {
    const allowed = await Promise.resolve(this.takeNow(tenantId, counter, capacity, windowMs, now));
    return allowed;
  }

  private takeNow(tenantId: string, counter: string, capacity: number, windowMs: number, now: number): boolean {
    const key = `${tenantId}:${counter}`;
    let entry = this.usage.get(key);
    if (entry === undefined) {
      entry = { hits: [] };
      this.usage.set(key, entry);
    }
    const cutoff = now - windowMs;
    entry.hits = entry.hits.filter((t) => t > cutoff);
    if (entry.hits.length >= capacity) {
      return false;
    }
    entry.hits.push(now);
    return true;
  }

  async usageOf(tenantId: string, counter: string): Promise<UsageSnapshot | undefined> {
    const entry = await Promise.resolve(this.usage.get(`${tenantId}:${counter}`));
    return entry === undefined ? undefined : { tenantId, counter, used: entry.hits.length, capacity: 0 };
  }
}

/** SQL-backed billing store (Postgres staging/production; SQLite integration tests). */
export class SqlBillingStore implements BillingStore {
  constructor(
    private readonly exec: SqlExecutor,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async applyEvent(event: PaymentProviderEvent, now: number): Promise<ApplyOutcome> {
    return this.exec.with(async (tx) => {
      // Dedupe FIRST, atomically inside the same transaction as the state
      // change: INSERT ... ON CONFLICT DO NOTHING claims the event id.
      const claimed = await tx.execute({
        sql: `INSERT INTO webhook_events (event_id, code, subscription_id, tenant_id, occurred_at)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (event_id) DO NOTHING`,
        params: [event.eventId, event.code, event.subscriptionId, event.tenantId, new Date(now).toISOString()],
      });
      if (claimed === 0) {
        return 'duplicate' as const;
      }
      const rows = await tx.query({
        sql: `SELECT tenant_id, subscription_id, plan_id, provider_status,
                     entitlement_status, grace_ends_at, updated_at
              FROM subscriptions WHERE tenant_id = $1`,
        params: [event.tenantId],
      });
      const current = rows[0] === undefined ? undefined : rowToRecord(rows[0]);
      const next = resolveExpiredGrace(applySubscriptionEvent(current, event, now), now);
      await tx.execute({
        sql: `INSERT INTO subscriptions (tenant_id, subscription_id, plan_id, provider_status,
                entitlement_status, grace_ends_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT (tenant_id) DO UPDATE SET
                subscription_id = excluded.subscription_id,
                plan_id = excluded.plan_id,
                provider_status = excluded.provider_status,
                entitlement_status = excluded.entitlement_status,
                grace_ends_at = excluded.grace_ends_at,
                updated_at = excluded.updated_at`,
        params: [
          next.tenantId,
          next.subscriptionId,
          next.planId,
          next.providerStatus,
          next.entitlementStatus,
          next.graceEndsAt === null ? null : new Date(next.graceEndsAt).toISOString(),
          new Date(next.updatedAt).toISOString(),
        ],
      });
      await tx.execute({
        sql: `INSERT INTO entitlements (tenant_id, plan_id, status, grace_ends_at, updated_at)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (tenant_id) DO UPDATE SET
                plan_id = excluded.plan_id,
                status = excluded.status,
                grace_ends_at = excluded.grace_ends_at,
                updated_at = excluded.updated_at`,
        params: [
          next.tenantId,
          next.planId,
          next.entitlementStatus,
          next.graceEndsAt === null ? null : new Date(next.graceEndsAt).toISOString(),
          new Date(next.updatedAt).toISOString(),
        ],
      });
      return 'applied' as const;
    });
  }

  async subscriptionOf(tenantId: string): Promise<SubscriptionRecord | undefined> {
    const rows = await this.exec.query({
      sql: `SELECT tenant_id, subscription_id, plan_id, provider_status,
                   entitlement_status, grace_ends_at, updated_at
            FROM subscriptions WHERE tenant_id = $1`,
      params: [tenantId],
    });
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async entitlementOf(tenantId: string, now: number): Promise<SubscriptionRecord | undefined> {
    const rec = await this.subscriptionOf(tenantId);
    return rec === undefined ? undefined : resolveExpiredGrace(rec, now);
  }

  async take(tenantId: string, counter: string, capacity: number, windowMs: number, now: number): Promise<boolean> {
    return this.exec.with(async (tx) => {
      // First-materialization fix (M9 verification defect 2): SELECT … FOR
      // UPDATE cannot lock a row that does not exist yet, so the first N
      // concurrent takes for a fresh (tenant, counter) each saw "no row",
      // each wrote a singleton hits list, and each returned true —
      // exceeding capacity (reproduced 18/20 rounds on real PG). Fix:
      // materialize the row INSIDE the transaction before the locked
      // read. ON CONFLICT DO NOTHING claims it exactly once; the
      // transactions that lose the insert race still find an existing
      // row and serialize on its lock. SQLite is covered by the same
      // statement (single-writer connection, ON CONFLICT supported).
      await tx.execute({
        sql: `INSERT INTO usage_counters (tenant_id, counter, window_ms, hits)
              VALUES ($1, $2, $3, '[]')
              ON CONFLICT (tenant_id, counter) DO NOTHING`,
        params: [tenantId, counter, windowMs],
      });
      // Read-modify-write under FOR UPDATE (Postgres): with the row now
      // guaranteed to exist, the lock fully serializes concurrent takes.
      // SQLite serializes writers on one connection.
      const selectSql = this.exec.kind === 'postgres'
        ? `SELECT hits FROM usage_counters WHERE tenant_id = $1 AND counter = $2 FOR UPDATE`
        : `SELECT hits FROM usage_counters WHERE tenant_id = $1 AND counter = $2`;
      const rows = await tx.query({ sql: selectSql, params: [tenantId, counter] });
      let hits: number[] = [];
      const row = rows[0];
      if (row !== undefined) {
        try {
          const parsed = JSON.parse(String(row.hits)) as unknown;
          if (Array.isArray(parsed)) {
            hits = parsed.filter((x): x is number => typeof x === 'number');
          }
        } catch {
          hits = []; // corrupt row: fail closed (same rule as publish budgets)
        }
      }
      const cutoff = now - windowMs;
      hits = hits.filter((t) => t > cutoff);
      if (hits.length >= capacity) {
        await tx.execute({
          sql: `INSERT INTO usage_counters (tenant_id, counter, window_ms, hits)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (tenant_id, counter) DO UPDATE SET hits = excluded.hits`,
          params: [tenantId, counter, windowMs, JSON.stringify(hits)],
        });
        return false;
      }
      hits.push(now);
      await tx.execute({
        sql: `INSERT INTO usage_counters (tenant_id, counter, window_ms, hits, updated_at)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (tenant_id, counter) DO UPDATE SET hits = excluded.hits, updated_at = excluded.updated_at`,
        params: [tenantId, counter, windowMs, JSON.stringify(hits), new Date(now).toISOString()],
      });
      return true;
    });
  }

  async usageOf(tenantId: string, counter: string): Promise<UsageSnapshot | undefined> {
    const rows = await this.exec.query({
      sql: `SELECT hits FROM usage_counters WHERE tenant_id = $1 AND counter = $2`,
      params: [tenantId, counter],
    });
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    let used = 0;
    try {
      const parsed = JSON.parse(String(row.hits)) as unknown;
      if (Array.isArray(parsed)) {
        used = parsed.length;
      }
    } catch {
      used = 0;
    }
    return { tenantId, counter, used, capacity: 0 };
  }
}

function rowToRecord(row: Record<string, unknown>): SubscriptionRecord {
  const grace = row.grace_ends_at;
  const graceMs =
    grace instanceof Date ? grace.getTime()
    : typeof grace === 'string' ? Date.parse(grace.endsWith('Z') ? grace : `${grace}Z`)
    : null;
  const updated = row.updated_at;
  const updatedMs =
    updated instanceof Date ? updated.getTime()
    : typeof updated === 'string' ? Date.parse(updated.endsWith('Z') ? updated : `${updated}Z`)
    : Date.now();
  return {
    tenantId: String(row.tenant_id),
    subscriptionId: String(row.subscription_id),
    planId: String(row.plan_id),
    providerStatus: String(row.provider_status),
    entitlementStatus: String(row.entitlement_status) as EntitlementStatus,
    graceEndsAt: Number.isFinite(graceMs) ? graceMs : null,
    updatedAt: Number.isFinite(updatedMs) ? (updatedMs) : Date.now(),
  };
}
