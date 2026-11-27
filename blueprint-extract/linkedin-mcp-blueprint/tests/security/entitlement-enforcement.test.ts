/**
 * M9 issue #14 — hosted entitlement enforcement test matrix.
 *
 * Covers: valid/missing/expired/revoked entitlements, tenant isolation +
 * cross-tenant rejection, usage limits, atomic quota consumption under
 * concurrency, cache invalidation on webhook transitions, provider-failure
 * behavior (enforcement never calls the provider), and the SELF-HOSTED
 * default: billing disabled -> no hosted payment requirement.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig, ConfigError } from '../../src/config/config.js';
import {
  BillingEnforcement,
  DisabledBillingEnforcement,
  EntitlementRequiredError,
  InMemoryBillingStore,
  UsageLimitExceededError,
  isBillingEnabled,
  processWebhook,
  signRazorpayBody,
} from '../../src/billing/index.js';

const SECRET = 'test-webhook-secret-0123456789';
const NOW = 1_700_000_000_000;

/** Deterministic clock the store + enforcement share. */
let clock = NOW;
const tick = (ms: number): void => {
  clock += ms;
};

function newEnforcement(limits: Record<string, number> = { pro: 3 }): {
  enforcement: BillingEnforcement;
  store: InMemoryBillingStore;
  auditLog: string[];
} {
  const store = new InMemoryBillingStore();
  const auditLog: string[] = [];
  const enforcement = new BillingEnforcement({
    store,
    limits,
    now: () => clock,
    windowMs: 30 * 86_400_000,
  });
  return { enforcement, store, auditLog: auditLog.concat() };
}

async function applyEvent(store: InMemoryBillingStore, id: string, code: string, tenant: string): Promise<void> {
  const body = Buffer.from(JSON.stringify({
    event: code,
    event_id: id,
    created_at: clock,
    payload: { subscription: { id: 'sub_1', plan_id: 'pro', status: 'active', tenant_id: tenant } },
  }));
  await processWebhook(body, signRazorpayBody(body, SECRET), id, {
    store,
    secret: SECRET,
    maxBodyBytes: 1024 * 1024,
    now: () => clock,
  });
}

describe('issue #14: entitlement enforcement gate', () => {
  it('allows a tool call with a valid active entitlement (quota consumed)', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement();
    await applyEvent(store, 'evt_e1', 'subscription.authenticated', 'tenant-a');
    await expect(enforcement.gateToolCall('tenant-a', 'linkedin_status')).resolves.toBeUndefined();
    const usage = await store.usageOf('tenant-a', 'tool-calls');
    expect(usage?.used).toBe(1);
  });

  it('rejects with a typed error when NO entitlement exists (fail closed)', async () => {
    clock = NOW;
    const { enforcement } = newEnforcement();
    await expect(enforcement.gateToolCall('tenant-no-sub', 'linkedin_status')).rejects.toBeInstanceOf(EntitlementRequiredError);
  });

  it('rejects when the entitlement is revoked (cancelled webhook)', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement();
    await applyEvent(store, 'evt_v1', 'subscription.authenticated', 'tenant-a');
    await applyEvent(store, 'evt_v2', 'subscription.cancelled', 'tenant-a');
    enforcement.invalidate('*'); // webhook transitions purge the cache
    await expect(enforcement.gateToolCall('tenant-a', 'linkedin_status')).rejects.toBeInstanceOf(EntitlementRequiredError);
  });

  it('rejects when the entitlement expired (grace window elapsed)', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement();
    await applyEvent(store, 'evt_x1', 'subscription.authenticated', 'tenant-a');
    await applyEvent(store, 'evt_x2', 'subscription.pending', 'tenant-a');
    tick(8 * 86_400_000); // beyond the 7-day grace
    await expect(enforcement.gateToolCall('tenant-a', 'linkedin_status')).rejects.toBeInstanceOf(EntitlementRequiredError);
  });

  it('permits during a past_due grace window (7-day grace policy)', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement({ pro: 10 });
    await applyEvent(store, 'evt_g1', 'subscription.authenticated', 'tenant-a');
    await applyEvent(store, 'evt_g2', 'subscription.halted', 'tenant-a');
    tick(3 * 86_400_000); // 3 days into grace
    await expect(enforcement.gateToolCall('tenant-a', 'linkedin_status')).resolves.toBeUndefined();
  });

  it('enforces usage limits: exhaustion throws UsageLimitExceededError', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement({ pro: 2 });
    await applyEvent(store, 'evt_u1', 'subscription.authenticated', 'tenant-a');
    await enforcement.gateToolCall('tenant-a', 'call-1');
    await enforcement.gateToolCall('tenant-a', 'call-2');
    await expect(enforcement.gateToolCall('tenant-a', 'call-3')).rejects.toBeInstanceOf(UsageLimitExceededError);
    const usage = await store.usageOf('tenant-a', 'tool-calls');
    expect(usage?.used).toBe(2); // exhausted, not over-consumed
  });

  it('window rolls: capacity returns after the metering window elapses', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement({ pro: 1 });
    await applyEvent(store, 'evt_w1', 'subscription.authenticated', 'tenant-a');
    await enforcement.gateToolCall('tenant-a', 'call-1');
    await expect(enforcement.gateToolCall('tenant-a', 'call-2')).rejects.toBeInstanceOf(UsageLimitExceededError);
    tick(30 * 86_400_000 + 1); // window is 30 days
    await expect(enforcement.gateToolCall('tenant-a', 'call-3')).resolves.toBeUndefined();
  });

  it('fails closed for an unmapped plan (config error, not silent unlimited)', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement({ /* no plans */ });
    await applyEvent(store, 'evt_p1', 'subscription.authenticated', 'tenant-a');
    await expect(enforcement.gateToolCall('tenant-a', 'linkedin_status')).rejects.toBeInstanceOf(EntitlementRequiredError);
  });
});

describe('issue #14: tenant isolation', () => {
  it('one tenant has an entitlement, another does NOT (no leakage)', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement();
    await applyEvent(store, 'evt_i1', 'subscription.authenticated', 'tenant-a');
    await expect(enforcement.gateToolCall('tenant-a', 't')).resolves.toBeUndefined();
    await expect(enforcement.gateToolCall('tenant-b', 't')).rejects.toBeInstanceOf(EntitlementRequiredError);
    // And usage counters are separate:
    const ua = await store.usageOf('tenant-a', 'tool-calls');
    expect(ua?.used).toBe(1);
    const ub = await store.usageOf('tenant-b', 'tool-calls');
    expect(ub).toBeUndefined();
  });

  it('usage on one tenant never consumes another tenant quota', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement({ pro: 2 });
    await applyEvent(store, 'evt_q1', 'subscription.authenticated', 'tenant-a');
    await applyEvent(store, 'evt_q2', 'subscription.authenticated', 'tenant-b');
    await expect(enforcement.gateToolCall('tenant-a', 't')).resolves.toBeUndefined();
    // tenant-a exhausts its 2-unit quota; tenant-b is unaffected:
    await expect(enforcement.gateToolCall('tenant-b', 't')).resolves.toBeUndefined();
    await expect(enforcement.gateToolCall('tenant-a', 't2')).resolves.toBeUndefined();
    await expect(enforcement.gateToolCall('tenant-a', 't3')).rejects.toBeInstanceOf(UsageLimitExceededError);
    await expect(enforcement.gateToolCall('tenant-b', 't2')).resolves.toBeUndefined();
  });
});

describe('issue #14: concurrency (atomic quota consumption)', () => {
  it('concurrent gate calls never exceed capacity (in-memory store)', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement({ pro: 5 });
    await applyEvent(store, 'evt_c1', 'subscription.authenticated', 'tenant-a');
    const attempts = Array.from({ length: 12 }, (_, i) =>
      enforcement.gateToolCall('tenant-a', `call-${String(i)}`).then(() => 'ok').catch((e: unknown) => (e instanceof UsageLimitExceededError ? 'rejected' : 'error')));
    const results = await Promise.all(attempts);
    const okCount = results.filter((r) => r === 'ok').length;
    expect(okCount).toBe(5); // exactly capacity, never more
  });
});

describe('issue #14: cache invalidation on webhook transitions', () => {
  it('revocation takes effect immediately after invalidate(*) (no TTL wait)', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement();
    await applyEvent(store, 'evt_k1', 'subscription.authenticated', 'tenant-a');
    await expect(enforcement.gateToolCall('tenant-a', 't')).resolves.toBeUndefined();
    // The decision is now cached; a cancel webhook + invalidate must evict it.
    await applyEvent(store, 'evt_k2', 'subscription.cancelled', 'tenant-a');
    enforcement.invalidate('*');
    await expect(enforcement.gateToolCall('tenant-a', 't')).rejects.toBeInstanceOf(EntitlementRequiredError);
  });

  it('cache is bounded: TTL expiry re-reads the store (stale usable flag self-heals)', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement();
    await applyEvent(store, 'evt_ttl1', 'subscription.authenticated', 'tenant-a');
    await expect(enforcement.gateToolCall('tenant-a', 't')).resolves.toBeUndefined();
    // Entitlement moves to past_due WITHOUT invalidate (TTL is the bound):
    await applyEvent(store, 'evt_ttl2', 'subscription.pending', 'tenant-a');
    tick(61_000 + 8 * 86_400_000); // past cache TTL AND past grace
    await expect(enforcement.gateToolCall('tenant-a', 't')).rejects.toBeInstanceOf(EntitlementRequiredError);
  });
});

describe('issue #14: self-hosted deployments (the hard constraint)', () => {
  it('DisabledBillingEnforcement allows every call with zero store access', async () => {
    const disabled = new DisabledBillingEnforcement();
    // No entitlement exists at all — self-hosted must never require one.
    await expect(disabled.gateToolCall('any-tenant', 'any-tool')).resolves.toBeUndefined();
    expect(isBillingEnabled(disabled)).toBe(false);
  });

  it('BILLING_ENABLED default is false (self-host never asks for payment)', () => {
    // Config default check (parseConfig with a minimal env):
    const cfg = parseConfig({ ENVIRONMENT: 'local' });
    expect(cfg.BILLING_ENABLED).toBe(false);
    expect(cfg.RAZORPAY_WEBHOOK_SECRET).toBeUndefined();
  });

  it('billing cannot be enabled without persistence or secret (fail-closed config)', () => {
    expect(() => parseConfig({ ENVIRONMENT: 'local', BILLING_ENABLED: 'true' })).toThrow(ConfigError); // no DATABASE_URL
    expect(() => parseConfig({
      ENVIRONMENT: 'local', BILLING_ENABLED: 'true', DATABASE_URL: 'sqlite::memory:',
    })).toThrow(ConfigError); // no webhook secret
  });

  it('provider outage cannot affect enforcement: gate path makes no provider call', async () => {
    clock = NOW;
    const { enforcement, store } = newEnforcement({ pro: 10 });
    await applyEvent(store, 'evt_o1', 'subscription.authenticated', 'tenant-a');
    // The gate resolved purely from local state. The enforcement object has
    // no provider client reference at all — structural proof (only the
    // store + limits options exist):
    expect(Object.keys(enforcement)).toContain('opts');
    expect(Object.keys(enforcement)).not.toContain('provider');
    expect(Object.keys(enforcement)).not.toContain('client');
    await expect(enforcement.gateToolCall('tenant-a', 't')).resolves.toBeUndefined();
  });
});
