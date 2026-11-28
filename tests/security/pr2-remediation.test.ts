/**
 * PR2 acceptance tests — issues #26, #27, #28.
 *
 * #26 (P2): webhook dedupe key is derived from the SIGNED content when
 *    the body lacks event_id — replaying one validly-signed body with
 *    VARIED header ids no longer re-applies the event.
 * #27 (P2): engines floor matches the real node:sqlite requirement.
 * #28 (P2): scheduled_posts retention (terminal-only, TTL) and the
 *    disconnect cascade (outstanding schedules cancelled on disconnect).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { SqliteExecutor } from '../../src/storage/sqliteExecutor.js';
import { applyMigrations } from '../../src/storage/migrations.js';
import { SqlScheduledPostStore } from '../../src/scheduling/scheduledPostStore.js';
import { RetentionSweeper } from '../../src/storage/retention.js';
import { processWebhook } from '../../src/billing/webhookRoute.js';
import { InMemoryBillingStore } from '../../src/billing/billingStore.js';
import { readFileSync } from 'node:fs';
import { disconnectTool } from '../../src/tools/connectionTools.js';

const DIR = mkdtempSync(join(tmpdir(), 'lkm-pr2-'));
let exec: SqliteExecutor;
let store: SqlScheduledPostStore;
let billingStore: InMemoryBillingStore;

const SECRET = 'whsec-test-2';
beforeAll(async () => {
  exec = new SqliteExecutor(join(DIR, 'pr2.db'));
  await applyMigrations(exec);
  store = new SqlScheduledPostStore(exec, { maxAttempts: 3 });
  billingStore = new InMemoryBillingStore();
});

afterAll(async () => {
  await exec.close();
  rmSync(DIR, { recursive: true, force: true });
});

// ---- #26: webhook dedupe from signed content -------------------------- //

function signedPauseBody(tenant: string): { body: Buffer; sig: string } {
  // An event WITHOUT event_id in the body — the replay-window case.
  // No event_id in the body — the replay-window case from issue #26.
  // (payload.subscription carries the fields directly — the shape the
  // existing billing-webhook-e2e suite uses.)
  const body = Buffer.from(JSON.stringify({
    event: 'subscription.paused',
    created_at: 1_700_000_000_000,
    payload: { subscription: { id: 'sub_pr2', plan_id: 'pro', status: 'paused', tenant_id: tenant } },
  }));
  const sig = createHmac('sha256', SECRET).update(body).digest('hex');
  return { body, sig };
}

describe('issue #26 — dedupe key derived from signed content', () => {
  const tenant = 't26';

  it('replaying one signed body with DIFFERENT header ids is deduped (no re-application)', async () => {
    const { body, sig } = signedPauseBody(tenant);
    // First delivery: no event_id in body, header id A.
    const first = await processWebhook(body, sig, 'header-id-A', {
      store: billingStore, secret: SECRET, maxBodyBytes: 1_000_000,
    });
    expect(first).toBe('verified-applied');
    // Replay: SAME signed body, DIFFERENT header id — previously this
    // inserted a fresh webhook_events row and re-applied the event.
    const second = await processWebhook(body, sig, 'header-id-B', {
      store: billingStore, secret: SECRET, maxBodyBytes: 1_000_000,
    });
    expect(second).toBe('verified-duplicate'); // now dedupes
    // And a third with yet another header:
    const third = await processWebhook(body, sig, 'header-id-C', {
      store: billingStore, secret: SECRET, maxBodyBytes: 1_000_000,
    });
    expect(third).toBe('verified-duplicate');
  });
});

// ---- #27: engines floor -------------------------------------------------- //

describe('issue #27 — engines floor matches node:sqlite requirement', () => {
  it('package.json declares >=22.5.0', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe('>=22.5.0');
  });
});

// ---- #28: retention + disconnect cascade -------------------------------- //

describe('issue #28 — scheduled_posts retention (terminal only)', () => {
  it('terminal rows older than the horizon are swept; outstanding rows are never touched', async () => {
    // Terminal row updated far in the past: force updated_at back 91 days.
    await store.insert({ tenantId: 't28', postText: 'old terminal', runAtMs: Date.now() - 1 });
    await exec.execute({
      sql: "UPDATE scheduled_posts SET status = 'published', updated_at = $1",
      params: [new Date(Date.now() - 91 * 86_400_000).toISOString()],
    });
    // Outstanding row (scheduled) — must survive the sweep.
    const live = await store.insert({ tenantId: 't28', postText: 'still live', runAtMs: Date.now() + 3_600_000 });

    const sweeper = new RetentionSweeper(exec);
    const report = await sweeper.sweep(Date.now());
    expect(report.deleted.scheduled_posts).toBeGreaterThanOrEqual(1);

    const remaining = await store.list('t28');
    expect(remaining.map((r) => r.id)).toContain(live.id); // outstanding untouched
    expect(remaining.some((r) => r.postText === 'old terminal')).toBe(false); // terminal swept
  });
});

describe('issue #28 — disconnect cascade cancels outstanding schedules', () => {
  it('disconnectTool cancels scheduled+running rows for the tenant', async () => {
    // Two outstanding rows: one 'scheduled', one forced 'running'.
    const a = await store.insert({ tenantId: 't28b', postText: 'a', runAtMs: Date.now() + 60_000 });
    const b = await store.insert({ tenantId: 't28b', postText: 'b', runAtMs: Date.now() + 60_000 });
    await exec.execute({
      sql: "UPDATE scheduled_posts SET status = 'running' WHERE id = $1",
      params: [b.id],
    });
    // Build a minimal ToolContext with a real in-memory connection
    // service + the real store on the context.
    const { parseConfig } = await import('../../src/config/config.js');
    const { InMemoryTokenVault, generateVaultKey } = await import('../../src/auth/linkedin/tokenVault.js');
    const { LinkedInConnectionService } = await import('../../src/auth/linkedin/connectionService.js');
    const { PostOperationStore } = await import('../../src/auth/linkedin/postOperationStore.js');
    const { TokenBucket } = await import('../../src/usage/tokenBucket.js');
    const { LinkedInMockProvider } = await import('../../src/auth/linkedin/mockProvider.js');
    const tenant = { tenantId: 't28b', userId: 't28b' };
    const vault = new InMemoryTokenVault(generateVaultKey());
    const provider = new LinkedInMockProvider();
    const ctx = {
      config: parseConfig({ ENVIRONMENT: 'local' }),
      tenant,
      connection: new LinkedInConnectionService(parseConfig({ ENVIRONMENT: 'local' }), provider, vault, () => Date.now()),
      callBudget: new TokenBucket(60, 86_400_000),
      vault,
      provider,
      postOps: new PostOperationStore(600_000),
      publishBudget: new TokenBucket(50, 86_400_000),
      now: () => Date.now(),
      scheduledPosts: store,
    } as unknown as Parameters<typeof disconnectTool>[0];

    // Tenant must be connected for the authorize() gate to allow
    // disconnect: put a token in the vault.
    await vault.put(tenant, {
      accessToken: 'x', refreshToken: undefined, expiresAt: Date.now() + 3_600_000,
      scopes: ['openid', 'profile', 'w_member_social'], memberSub: 'm28',
    });
    const result = await disconnectTool(ctx);
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { disconnected?: boolean; cancelledScheduledPosts?: number };
    expect(payload.disconnected).toBe(true);
    expect(payload.cancelledScheduledPosts).toBe(2); // both outstanding rows

    const rows = await store.list('t28b');
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
    expect(rows.some((r) => r.id === a.id)).toBe(true);
  });
});
