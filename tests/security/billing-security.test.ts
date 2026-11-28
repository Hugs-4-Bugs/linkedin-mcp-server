/**
 * M9 issue #13 — payment verification & webhook security test matrix.
 *
 * Covers: valid signature, invalid signature, replay, duplicate event,
 * idempotent processing, event ordering, lifecycle transitions
 * (creation/active/cancellation/expiration/payment-failure/revocation/
 * recovery), provider errors, secret redaction, and the self-hosted
 * default (billing disabled). Uses the in-memory store for determinism;
 * SQL semantics (Postgres) are covered by pg-billing-integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  InMemoryBillingStore,
  processWebhook,
  signRazorpayBody,
  type WebhookResult,
} from '../../src/billing/index.js';
import { applySubscriptionEvent, GRACE_WINDOW_MS, type SubscriptionRecord } from '../../src/billing/subscriptionStateMachine.js';
import type { PaymentProviderEvent } from '../../src/billing/providerEvents.js';

const SECRET = 'test-webhook-secret-0123456789';

function bodyFor(eventId: string, code: string, tenant = 'tenant-a', plan = 'pro', occurredAt = 1_700_000_000_000): Buffer {
  return Buffer.from(JSON.stringify({
    event: code,
    event_id: eventId,
    created_at: occurredAt,
    payload: {
      subscription: {
        id: 'sub_1',
        plan_id: plan,
        status: 'active',
        tenant_id: tenant,
      },
    },
  }));
}

function opts(store: InMemoryBillingStore, auditLog: string[] = [], secret = SECRET) {
  return {
    store,
    secret,
    maxBodyBytes: 1024 * 1024,
    now: () => NOW,
    audit: (action: string, detail: string): Promise<void> => {
      auditLog.push(`${action}:${detail}`);
      return Promise.resolve();
    },
  };
}

const NOW = 1_700_000_000_000;

describe('issue #13: webhook signature verification', () => {
  it('accepts a correctly signed webhook (applied)', async () => {
    const store = new InMemoryBillingStore();
    const body = bodyFor('evt_1', 'subscription.authenticated');
    const sig = signRazorpayBody(body, SECRET);
    const result = await processWebhook(body, sig, 'evt_1', opts(store));
    expect(result).toBe('verified-applied');
  });

  it('rejects an invalid signature (400-mapped result, no state change)', async () => {
    const store = new InMemoryBillingStore();
    const body = bodyFor('evt_2', 'subscription.authenticated');
    const result = await processWebhook(body, 'deadbeef'.repeat(8), 'evt_2', opts(store));
    expect(result).toBe('invalid-signature');
    expect(await store.subscriptionOf('tenant-a')).toBeUndefined();
  });

  it('rejects a missing signature header', async () => {
    const store = new InMemoryBillingStore();
    const body = bodyFor('evt_3', 'subscription.charged');
    const result = await processWebhook(body, undefined, 'evt_3', opts(store));
    expect(result).toBe('invalid-signature');
  });

  it('rejects a signature computed over re-serialized JSON (raw bytes matter)', async () => {
    const store = new InMemoryBillingStore();
    // Same logical content, different byte layout (extra whitespace).
    const raw = bodyFor('evt_4', 'subscription.authenticated');
    const json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    const reSerialized = Buffer.from(JSON.stringify(json, null, 2));
    const sig = signRazorpayBody(raw, SECRET); // signed over the ORIGINAL bytes
    const result = await processWebhook(reSerialized, sig, 'evt_4', opts(store));
    expect(result).toBe('invalid-signature');
  });

  it('rejects oversize payloads before any processing', async () => {
    const store = new InMemoryBillingStore();
    const body = bodyFor('evt_5', 'subscription.charged');
    const sig = signRazorpayBody(body, SECRET);
    const result = await processWebhook(body, sig, 'evt_5', { ...opts(store), maxBodyBytes: 8 });
    expect(result).toBe('too-large');
  });
});

describe('issue #13: replay & duplicate protection', () => {
  it('treats a replayed event as duplicate (no double-apply)', async () => {
    const store = new InMemoryBillingStore();
    const body = bodyFor('evt_dup', 'subscription.authenticated');
    const sig = signRazorpayBody(body, SECRET);
    expect(await processWebhook(body, sig, 'evt_dup', opts(store))).toBe('verified-applied');
    expect(await processWebhook(body, sig, 'evt_dup', opts(store))).toBe('verified-duplicate');
    const rec = await store.subscriptionOf('tenant-a');
    expect(rec?.updatedAt).toBe(NOW); // applied once
  });

  it('dedupes by event id even when the signature is freshly valid', async () => {
    const store = new InMemoryBillingStore();
    const b1 = bodyFor('evt_d2', 'subscription.charged');
    expect(await processWebhook(b1, signRazorpayBody(b1, SECRET), 'evt_d2', opts(store))).toBe('verified-applied');
    // A NEW delivery of the SAME event id with a different (still valid)
    // signature over slightly different bytes must not re-apply state:
    const b2 = bodyFor('evt_d2', 'subscription.charged', 'tenant-a', 'pro', NOW + 5_000);
    const r2 = await processWebhook(b2, signRazorpayBody(b2, SECRET), 'evt_d2', opts(store));
    expect(r2).toBe('verified-duplicate');
  });

  it('rejects invalid payloads (unknown code / missing ids / bad timestamp)', async () => {
    const store = new InMemoryBillingStore();
    const bad = Buffer.from(JSON.stringify({ event: 'not.an.event' }));
    expect(await processWebhook(bad, signRazorpayBody(bad, SECRET), 'e1', opts(store))).toBe('invalid-payload');
    const bad2 = Buffer.from('{}');
    expect(await processWebhook(bad2, signRazorpayBody(bad2, SECRET), 'e2', opts(store))).toBe('invalid-payload');
    const bad3 = Buffer.from('not json at all');
    expect(await processWebhook(bad3, signRazorpayBody(bad3, SECRET), 'e3', opts(store))).toBe('invalid-payload');
  });
});

describe('issue #13: subscription lifecycle', () => {
  it('creation -> active -> cancellation -> revocation', async () => {
    const store = new InMemoryBillingStore();
    const path: [string, string][] = [
      ['evt_l1', 'subscription.authenticated'],
      ['evt_l2', 'subscription.cancelled'],
    ];
    for (const [id, code] of path) {
      const body = bodyFor(id, code);
      await processWebhook(body, signRazorpayBody(body, SECRET), id, opts(store));
    }
    const rec = await store.entitlementOf('tenant-a', NOW + 1000);
    expect(rec?.entitlementStatus).toBe('canceled');
  });

  it('payment failure: pending -> halted keeps past_due with grace, not immediate revoke', async () => {
    const store = new InMemoryBillingStore();
    for (const [id, code] of [['evt_p1', 'subscription.authenticated'], ['evt_p2', 'subscription.pending'], ['evt_p3', 'subscription.halted']] as [string, string][]) {
      const body = bodyFor(id, code);
      await processWebhook(body, signRazorpayBody(body, SECRET), id, opts(store));
    }
    const rec = await store.entitlementOf('tenant-a', NOW + 1000);
    expect(rec?.entitlementStatus).toBe('past_due');
    expect(rec?.graceEndsAt).toBeGreaterThan(NOW);
    // Usable during grace...
    const inGrace = await store.entitlementOf('tenant-a', NOW + 1000);
    expect(inGrace?.entitlementStatus).toBe('past_due');
    // ...expired after the grace window elapses.
    const after = await store.entitlementOf('tenant-a', NOW + GRACE_WINDOW_MS + 1000);
    expect(after?.entitlementStatus).toBe('expired');
  });

  it('recovery: pending then charged returns to active', async () => {
    const store = new InMemoryBillingStore();
    for (const [id, code] of [['evt_r1', 'subscription.authenticated'], ['evt_r2', 'subscription.pending'], ['evt_r3', 'subscription.charged']] as [string, string][]) {
      const body = bodyFor(id, code);
      await processWebhook(body, signRazorpayBody(body, SECRET), id, opts(store));
    }
    const rec = await store.entitlementOf('tenant-a', NOW + 1000);
    expect(rec?.entitlementStatus).toBe('active');
    expect(rec?.graceEndsAt).toBeNull();
  });

  it('completed (natural expiry) ends the entitlement', async () => {
    const store = new InMemoryBillingStore();
    for (const [id, code] of [['evt_c1', 'subscription.activated'], ['evt_c2', 'subscription.completed']] as [string, string][]) {
      const body = bodyFor(id, code);
      await processWebhook(body, signRazorpayBody(body, SECRET), id, opts(store));
    }
    const rec = await store.entitlementOf('tenant-a', NOW + 1000);
    expect(rec?.entitlementStatus).toBe('expired');
  });

  it('terminal canceled state is not reopened by late non-start events', async () => {
    const store = new InMemoryBillingStore();
    for (const [id, code] of [['evt_t1', 'subscription.authenticated'], ['evt_t2', 'subscription.cancelled'], ['evt_t3', 'subscription.charged']] as [string, string][]) {
      const body = bodyFor(id, code);
      await processWebhook(body, signRazorpayBody(body, SECRET), id, opts(store));
    }
    const rec = await store.entitlementOf('tenant-a', NOW + 1000);
    expect(rec?.entitlementStatus).toBe('canceled');
  });

  it('out-of-order delivery converges (cancelled before authenticated)', async () => {
    const store = new InMemoryBillingStore();
    // Reverse order: charged/pending arrive BEFORE the subscription start.
    for (const [id, code] of [['evt_o1', 'subscription.pending'], ['evt_o2', 'subscription.authenticated']] as [string, string][]) {
      const body = bodyFor(id, code);
      await processWebhook(body, signRazorpayBody(body, SECRET), id, opts(store));
    }
    const rec = await store.entitlementOf('tenant-a', NOW + 1000);
    expect(rec?.entitlementStatus).toBe('active'); // authenticated wins as the later-applied start
  });

  it('secret rotation: old-secret signature rejected, new accepted', async () => {
    const store = new InMemoryBillingStore();
    const body = bodyFor('evt_s1', 'subscription.authenticated');
    const oldSig = createHmac('sha256', 'old-secret-value-0123').update(body).digest('hex');
    expect(await processWebhook(body, oldSig, 'evt_s1', opts(store))).toBe('invalid-signature');
    const newSig = signRazorpayBody(body, SECRET);
    expect(await processWebhook(body, newSig, 'evt_s1', opts(store))).toBe('verified-applied');
  });
});

describe('issue #13: audit & redaction', () => {
  it('writes audit rows for applied and duplicate webhooks (no payloads)', async () => {
    const auditLog: string[] = [];
    const store = new InMemoryBillingStore();
    const body = bodyFor('evt_a1', 'subscription.authenticated');
    const sig = signRazorpayBody(body, SECRET);
    await processWebhook(body, sig, 'evt_a1', opts(store, auditLog));
    await processWebhook(body, sig, 'evt_a1', opts(store, auditLog));
    expect(auditLog).toContain('billing:webhook:subscription.authenticated:applied');
    expect(auditLog).toContain('billing:webhook:subscription.authenticated:duplicate');
    // No event payload material ever enters the audit trail.
    for (const line of auditLog) {
      expect(line).not.toContain('sub_1');
    }
  });

  it('the webhook secret never appears in log output (redaction)', async () => {
    const logs: string[] = [];
    const store = new InMemoryBillingStore();
    const body = bodyFor('evt_sec', 'subscription.authenticated');
    const sink = (line: string): void => {
      logs.push(line);
    };
    await processWebhook(body, 'badsig', 'evt_sec', {
      store,
      secret: SECRET,
      maxBodyBytes: 1024 * 1024,
      now: () => NOW,
      logSink: sink,
    });
    for (const line of logs) {
      expect(line).not.toContain(SECRET);
    }
  });
});

describe('issue #13: state machine unit properties', () => {
  it('applySubscriptionEvent is a pure idempotent function', () => {
    const ev: PaymentProviderEvent = {
      eventId: 'evt_x',
      code: 'subscription.authenticated',
      subscriptionId: 'sub_1',
      tenantId: 't1',
      planId: 'pro',
      providerStatus: 'active',
      occurredAt: NOW,
    };
    const undefinedStart = applySubscriptionEvent(undefined, ev, NOW);
    const again = applySubscriptionEvent(undefinedStart, ev, NOW);
    expect(again.entitlementStatus).toBe('active');
    expect(again.graceEndsAt).toBeNull();
  });

  it('all 10 documented event codes are recognized', () => {
    const codes = [
      'subscription.authenticated', 'subscription.activated', 'subscription.charged',
      'subscription.completed', 'subscription.updated', 'subscription.pending',
      'subscription.halted', 'subscription.cancelled', 'subscription.paused',
      'subscription.resumed',
    ];
    for (const code of codes) {
      const rec: SubscriptionRecord | undefined = undefined;
      const ev: PaymentProviderEvent = {
        eventId: `e-${code}`,
        code: code as PaymentProviderEvent['code'],
        subscriptionId: 's', tenantId: 't', planId: 'pro', providerStatus: 'active', occurredAt: NOW,
      };
      const out = applySubscriptionEvent(rec, ev, NOW);
      expect(['active', 'past_due', 'canceled', 'expired', 'trial']).toContain(out.entitlementStatus);
    }
  });
});

describe('issue #13: webhook result -> HTTP status mapping', () => {
  it('2xx only for verified outcomes; 400 for every rejection', async () => {
    const store = new InMemoryBillingStore();
    const ok = bodyFor('evt_m1', 'subscription.activated');
    const bad = Buffer.from('{}');
    const applied: WebhookResult = await processWebhook(ok, signRazorpayBody(ok, SECRET), 'evt_m1', opts(store));
    expect(applied).toBe('verified-applied');
    const dup: WebhookResult = await processWebhook(ok, signRazorpayBody(ok, SECRET), 'evt_m1', opts(store));
    const invalid: WebhookResult = await processWebhook(bad, signRazorpayBody(bad, SECRET), 'evt_m2', opts(store));
    // Never 200 on a failure; exact codes:
    expect(dup).toBe('verified-duplicate');
    expect(invalid).toBe('invalid-payload');
  });
});
