/**
 * M9 issue #14 — hosted entitlement enforcement gate.
 *
 * Server-side enforcement: the gate sits in the tool dispatch path
 * (serverFactory), reads ONLY the authenticated tenant (ALS context — same
 * non-bypassable path as tenant isolation, ADR-019), and consults the SQL
 * entitlement store, never any client-supplied status. Failure modes are
 * typed so tools surface structured billing errors instead of generic ones.
 *
 * Self-hosting protection: when enforcement is DISABLED (the default —
 * BILLING_ENABLED unset/false), `gateToolCall` is an immediate allow with
 * zero store access, zero provider calls and zero billing tables touched.
 */
import { createLogger } from '../observability/logger.js';
import type { BillingStore } from './billingStore.js';
import { entitlementUsable } from './subscriptionStateMachine.js';

const log = createLogger('billing:enforce');

export class EntitlementRequiredError extends Error {
  constructor() {
    super('A hosted subscription is required for this tool. Contact the operator.');
    this.name = 'EntitlementRequiredError';
  }
}

export class UsageLimitExceededError extends Error {
  constructor() {
    super('Plan usage limit reached for this billing period.');
    this.name = 'UsageLimitExceededError';
  }
}

/** Short-lived entitlement cache: purge on write; TTL bounds staleness. */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  usable: boolean;
  planId: string;
  cachedAt: number;
}

export interface BillingEnforcementOptions {
  store: BillingStore;
  /** Plan limits: planId -> monthly tool-call allowance. */
  limits: Record<string, number>;
  /** Metering window for the usage counter (default: 30 days). */
  windowMs?: number;
  /** Counter identity. */
  counter?: string;
  now?: () => number;
}

/**
 * Per-runtime enforcement gate. One instance per server build; safe for
 * concurrent tool calls (store.take is transaction-atomic; the cache is
 * only an optimization on the read path and can only be 60s stale, never
 * wrong on revocation for longer).
 */
export class BillingEnforcement {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly opts: BillingEnforcementOptions) {}

  /**
   * Gate a tool call for a tenant. Throws EntitlementRequiredError /
   * UsageLimitExceededError to REJECT; resolves to allow otherwise.
   * Audit hook (name + outcome only) mirrors the M7 audit discipline.
   */
  async gateToolCall(
    tenantId: string,
    toolName: string,
    audit?: (action: string, detail: string) => Promise<void>,
  ): Promise<void> {
    const now = this.opts.now?.() ?? Date.now();
    const windowMs = this.opts.windowMs ?? 30 * 86_400_000;
    const counter = this.opts.counter ?? 'tool-calls';

    // Read path: cached entitlement decision (bounded staleness).
    let entry = this.cache.get(tenantId);
    if (entry === undefined || now - entry.cachedAt > CACHE_TTL_MS) {
      const rec = await this.opts.store.entitlementOf(tenantId, now);
      if (rec === undefined) {
        // No entitlement row: hosted mode requires one — fail closed.
        entry = { usable: false, planId: '', cachedAt: now };
      } else {
        entry = {
          usable: entitlementUsable(rec.entitlementStatus, now, rec.graceEndsAt),
          planId: rec.planId,
          cachedAt: now,
        };
      }
      this.cache.set(tenantId, entry);
    }
    if (!entry.usable) {
      log.info('tool call rejected: no usable entitlement', { tenant: tenantId, tool: toolName });
      await audit?.('billing:rejected', `no-entitlement:${toolName}`);
      throw new EntitlementRequiredError();
    }
    // Write path: atomic quota consumption (never cached — every call
    // takes a unit; concurrency safety comes from the store transaction).
    const capacity = this.opts.limits[entry.planId] ?? 0;
    if (capacity > 0) {
      const allowed = await this.opts.store.take(tenantId, counter, capacity, windowMs, now);
      if (!allowed) {
        log.info('tool call rejected: usage limit', { tenant: tenantId, tool: toolName });
        await audit?.('billing:rejected', `usage-limit:${toolName}`);
        throw new UsageLimitExceededError();
      }
    } else {
      // Known plan but no limit mapping is a config error — fail closed
      // rather than silently unlimited.
      log.error('billing plan has no configured limit', { tenant: tenantId, plan: entry.planId });
      await audit?.('billing:rejected', `plan-unmapped:${toolName}`);
      throw new EntitlementRequiredError();
    }
    await audit?.('billing:allowed', toolName);
  }

  /**
   * Invalidate the read cache: for a tenantId, or '*' for every tenant
   * (webhook transitions call the latter — revocations land immediately).
   */
  invalidate(tenantId: string): void {
    if (tenantId === '*') {
      this.cache.clear();
      return;
    }
    this.cache.delete(tenantId);
  }
}

/**
 * The disabled gate: self-hosted mode. Zero store access, zero tables,
 * zero provider connectivity — a pure allow. Returned by the factory
 * whenever billing is not explicitly enabled (the default), which is how
 * "self-hosting must not require hosted payment" is enforced structurally.
 */
export class DisabledBillingEnforcement {
  readonly kind = 'disabled' as const;
  private invalidatedAll = false;
  private invalidatedOne: string | undefined;

  async gateToolCall(): Promise<void> {
    await Promise.resolve(); // allow — no billing dependency exists in this mode
    return;
  }

  invalidate(tenantId: string): void {
    // Disabled mode: nothing to invalidate (arg kept for interface parity).
    this.markInvalidated(tenantId);
  }

  private markInvalidated(tenantId: string): void {
    if (tenantId === '*') {
      this.invalidatedAll = true;
    } else {
      this.invalidatedOne = tenantId;
    }
  }
}

export type AnyBillingEnforcement = BillingEnforcement | DisabledBillingEnforcement;

/** Narrowing helper for the factory. */
export function isBillingEnabled(e: AnyBillingEnforcement): e is BillingEnforcement {
  return e instanceof BillingEnforcement;
}
