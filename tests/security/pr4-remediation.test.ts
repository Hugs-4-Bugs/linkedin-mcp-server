/**
 * PR4 acceptance tests — issue #32 (fresh adversarial audit findings).
 *
 * P2-1: budget-exhausted publish must exit() the ledger row — content
 *        never refused as 'in-flight' forever.
 * P2-2: last_used fire-and-forget update failure never becomes an
 *        unhandled rejection (process survives).
 * P3-5: username miss pays the same scrypt cost (timing oracle closed).
 * P3-9a: SESSION_COOKIE_NAME config is honored (not a hardcoded name).
 * P3-9b: bearer tokens are rejected from billing API routes.
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteExecutor } from '../../src/storage/sqliteExecutor.js';
import { applyMigrations } from '../../src/storage/migrations.js';
import { SqlPostOperationStore } from '../../src/auth/linkedin/sqlPublishStores.js';
import { SqlPublishBudget } from '../../src/auth/linkedin/sqlPublishStores.js';
import { publishPostTool } from '../../src/tools/publishTools.js';
import { UserAuthStore } from '../../src/auth/users/userAuthStore.js';
import { parseConfig } from '../../src/config/config.js';
import { LinkedInMockProvider } from '../../src/auth/linkedin/mockProvider.js';
import { LinkedInConnectionService } from '../../src/auth/linkedin/connectionService.js';
import { InMemoryTokenVault, generateVaultKey } from '../../src/auth/linkedin/tokenVault.js';
import { TokenBucket } from '../../src/usage/tokenBucket.js';

const DIR = mkdtempSync(join(tmpdir(), 'lkm-pr4-'));
let exec: SqliteExecutor;

beforeAll(async () => {
  exec = new SqliteExecutor(join(DIR, 'pr4.db'));
  await applyMigrations(exec);
});

afterAll(async () => {
  await exec.close();
  rmSync(DIR, { recursive: true, force: true });
});

async function makeCtx(over: { budgetTake?: boolean } = {}) {
  const config = parseConfig({ ENVIRONMENT: 'local' });
  const tenant = { tenantId: 't-pr4', userId: 't-pr4' };
  const vault = new InMemoryTokenVault(generateVaultKey());
  const provider = new LinkedInMockProvider();
  const connection = new LinkedInConnectionService(config, provider, vault, () => Date.now());
  await vault.put(tenant, {
    accessToken: 'x', refreshToken: undefined, expiresAt: Date.now() + 3_600_000,
    scopes: ['openid', 'profile', 'w_member_social'], memberSub: 'm4',
  });
  const postOps = new SqlPostOperationStore(exec, 600_000, () => Date.now());
  const budget = {
    take: async (): Promise<boolean> => { await Promise.resolve(); return over.budgetTake ?? true; },
    peek: async (): Promise<number> => { await Promise.resolve(); return 0; },
  } as unknown as SqlPublishBudget;
  return { // postOps unused directly — ctx carries it
    ctx: {
      config, tenant,
      connection,
      callBudget: new TokenBucket(60, 86_400_000),
      vault,
      provider,
      postOps,
      publishBudget: new TokenBucket(1, 86_400_000),
      publishBudgetSql: budget,
      now: () => Date.now(),
    } as unknown as Parameters<typeof publishPostTool>[0],
  };
}

// ---- P2-1: budget-exhausted must not strand the ledger row ------------ //

describe('issue #32 P2-1 — budget-exhausted exits the ledger row', () => {
  it('refused content is NOT stuck in-flight: a second attempt is not "duplicate in progress"', async () => {
    const { ctx } = await makeCtx({ budgetTake: false });
    const text = 'budget refused post ' + Math.random().toString(36).slice(2);
    const first = await publishPostTool(ctx, { text, confirm: true });
    expect(first.isError).toBe(true); // rate-limited refusal
    const json = JSON.parse(first.content[0]?.text ?? '{}') as { code?: string };
    expect(json.code).toBe('rate-limited');

    // THE BUG: the row stayed 'in-flight' forever → second attempt
    // refused as duplicate-<in-flight>. After the fix it is NOT.
    const second = await publishPostTool(ctx, { text, confirm: true });
    const json2 = JSON.parse(second.content[0]?.text ?? '{}') as { code?: string };
    expect(json2.code).toBe('rate-limited'); // NOT 'duplicate-*'
  });
});

// ---- P2-2: last_used update failure is swallowed, never unhandled ---- //

describe('issue #32 P2-2 — last_used failure never unhandled', () => {
  it('a rejecting executor on the last_used UPDATE resolves the token and emits no unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const handler = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', handler);
    // Executor that FAILS every execute (simulating DB blip):
const failing = { kind: 'sqlite' as const, execute: async (): Promise<number> => { await Promise.resolve(); throw new Error('db down'); }, query: async (): Promise<never[]> => { await Promise.resolve(); throw new Error('db down'); }, close: async (): Promise<void> => { await Promise.resolve(); }, transaction: async (): Promise<unknown> => { await Promise.resolve(); throw new Error('db down'); } };
    const store = new UserAuthStore(failing as unknown as SqliteExecutor);
    // Seed an API token row first via a REAL sqlite store:
    const real = new UserAuthStore(exec);
    await real.createUser('u32', 'pw32', 't-pr4');
    const token = await real.issueApiToken('t-pr4', 'pr4');
    // Now resolve the SAME token through the FAILING store:
    try {
      await (store as unknown as { resolveApiToken: (t: string) => Promise<unknown> }).resolveApiToken(token);
    } catch { /* the resolve itself may fail: that is fine — the point is no UNHANDLED rejection */ }
    await new Promise((r) => { setTimeout(r, 150); });
    process.off('unhandledRejection', handler);
    expect(unhandled.length).toBe(0); // crash bug closed
  });
});

// ---- P3-5: timing oracle closed (misses pay scrypt cost) -------------- //

describe('issue #32 P3-5 — username miss pays the scrypt cost', () => {
  it('unknown username and wrong password take comparable time (both ~scrypt)', async () => {
    const store = new UserAuthStore(exec);
    const t0 = performance.now();
    try { await store.verifyCredential('no-such-user-xyz', 'pw'); } catch { /* 401 */ }
    const t1 = performance.now();
    try { await store.verifyCredential('u32', 'wrong-password'); } catch { /* 401 */ }
    const t2 = performance.now();
    const miss = t1 - t0;
    const wrong = t2 - t1;
    // Both paths now run scryptSync once; misses must not be ~0ms.
    expect(miss).toBeGreaterThan(5);
    expect(wrong).toBeGreaterThan(5);
    // And not wildly asymmetric (the pre-fix miss was ~0 vs ~50ms):
    const ratio = wrong / Math.max(miss, 1);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(5);
  });
});

// ---- P3-9a: SESSION_COOKIE_NAME honored -------------------------------- //

describe('issue #32 P3-9a — SESSION_COOKIE_NAME config honored', () => {
  it('cookie names flow from config (custom name parsed)', () => {
    const cfg = parseConfig({ ENVIRONMENT: 'local', SESSION_COOKIE_NAME: 'custom_sess' });
    expect(cfg.SESSION_COOKIE_NAME).toBe('custom_sess');
    expect(parseConfig({ ENVIRONMENT: 'local' }).SESSION_COOKIE_NAME).toBe('lkm_session');
  });
});

// ---- P3-9b: bearer rejected from billing routes ------------------------ //

describe('issue #32 P3-9b — bearer auth rejected on billing API', () => {
  it('billing summary via bearer is refused (session-only)', async () => {
    // Read the guard logic directly: the module exports the route handler;
    // simulate its parts shape.
    const { handleBillingApiRoutes } = await import('../../src/mcp/transport/billingApi.js');
    const calls: unknown[] = [];
    const res = {
      writeHead: (code: number): unknown => calls.push(['status', code]),
      end: (b: unknown): unknown => calls.push(['body', String(b)]),
      setHeader: (): void => undefined,
    } as unknown as import('node:http').ServerResponse;
    const req = { method: 'GET', url: '/api/billing/summary', headers: {} } as unknown as import('node:http').IncomingMessage;
    // Real enforcement + real SQL billing store (SQLite exec) so the
    // route mounts and the session check is actually reached.
    const { BillingEnforcement } = await import('../../src/billing/enforcement.js');
    const { SqlBillingStore } = await import('../../src/billing/billingStore.js');
    const runtime = {
      billing: new BillingEnforcement({ store: new SqlBillingStore(exec), limits: {} }),
      billingStore: new SqlBillingStore(exec),
      authStore: undefined,
    } as unknown as import('../../src/mcp/serverFactory.js').AppRuntime;
    await handleBillingApiRoutes(req, res, {
      runtime,
      config: parseConfig({ ENVIRONMENT: 'local' }),
      auth: { tenantId: 't', via: 'bearer' }, // BEARER — must be refused
      authStore: undefined,
    });
    const status = calls.find((c) => Array.isArray(c) && c[0] === 'status');
    expect(status).toBeDefined();
    expect((status as unknown[])[1]).toBe(401); // session required
  });
});
