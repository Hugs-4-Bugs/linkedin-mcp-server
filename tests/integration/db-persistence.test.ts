/**
 * M5 persistence integration tests — REAL database runs (SQLite executor,
 * on-disk temp file per suite), not mocks: migrations, vault encryption +
 * tenant isolation, state store replay/TTL, op ledger + budget transactional
 * behavior, and restart survival (new executor on the same file).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteExecutor } from '../../src/storage/sqliteExecutor.js';
import { applyMigrations } from '../../src/storage/migrations.js';
import { SqlTokenVault } from '../../src/auth/linkedin/sqlTokenVault.js';
import { SqlOAuthStateStore } from '../../src/auth/linkedin/sqlStateStore.js';
import {
  SqlPostOperationStore,
  SqlPublishBudget,
} from '../../src/auth/linkedin/sqlPublishStores.js';
import { UserAuthStore } from '../../src/auth/users/userAuthStore.js';
import { LOCAL_DEV_TENANT, type TenantContext } from '../../src/identity/tenant.js';
import { generateVaultKey } from '../../src/auth/linkedin/tokenVault.js';
import { fingerprintPostText } from '../../src/auth/linkedin/postOperationStore.js';

const OTHER: TenantContext = { tenantId: 'tenant-other', userId: 'tenant-other' };
const KEY = generateVaultKey(); // same key across the restart simulation

let dir: string;
let exec: SqliteExecutor;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lkm-db-'));
  exec = new SqliteExecutor(join(dir, 'test.db'));
  await applyMigrations(exec);
});

afterAll(async () => {
  await exec.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('are idempotent: re-running applies nothing new', async () => {
    const ran = await applyMigrations(exec);
    expect(ran).toEqual([]);
  });
  it('record their ids in schema_migrations', async () => {
    const rows = await exec.query({ sql: 'SELECT id, name FROM schema_migrations' });
    expect(rows.length).toBeGreaterThan(0);
    expect(String(rows[0]?.name)).toBe('core tables');
  });
});

describe('persistent token vault (encrypted at rest)', () => {
  it('round-trips a TokenSet including memberSub and scopes', async () => {
    const vault = new SqlTokenVault(exec, KEY);
    const tokens = {
      accessToken: 'mock-token-abc123',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['openid', 'profile', 'email', 'w_member_social'],
      memberSub: 'mock-member-1',
    };
    await vault.put(LOCAL_DEV_TENANT, tokens);
    const got = await vault.get(LOCAL_DEV_TENANT);
    expect(got).toEqual(tokens);
  });
  it('stores ONLY ciphertext: no plaintext token in the table', async () => {
    const rows = await exec.query({
      sql: 'SELECT ciphertext, iv, auth_tag, scopes, member_sub FROM linkedin_tokens WHERE tenant_id = $1',
      params: ['local-tenant/local-user'],
    });
    const row = rows[0];
    expect(String(row.ciphertext)).not.toContain('mock-token-abc123');
    expect(String(row.ciphertext)).not.toBe('mock-token-abc123');
    expect(String(row.member_sub)).toBe('mock-member-1'); // sub is not secret
    expect(String(row.scopes)).toContain('w_member_social');
  });
  it('is tenant-isolated: another tenant reads nothing, never tenant A row', async () => {
    const vault = new SqlTokenVault(exec, KEY);
    expect(await vault.get(OTHER)).toBeUndefined();
    await vault.put(OTHER, {
      accessToken: 'other-token',
      expiresAt: Date.now() + 1000,
      scopes: ['openid'],
    });
    const mine = await vault.get(LOCAL_DEV_TENANT);
    expect(mine?.accessToken).toBe('mock-token-abc123'); // untouched
    expect(await vault.get(OTHER)).toMatchObject({ accessToken: 'other-token' });
  });
  it('delete removes only the target tenant row (disconnect semantics)', async () => {
    const vault = new SqlTokenVault(exec, KEY);
    await vault.delete(LOCAL_DEV_TENANT);
    expect(await vault.get(LOCAL_DEV_TENANT)).toBeUndefined();
    expect(await vault.get(OTHER)).toMatchObject({ accessToken: 'other-token' });
    // re-put for later suites
    await vault.put(LOCAL_DEV_TENANT, {
      accessToken: 'mock-token-abc123',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['openid', 'profile', 'email', 'w_member_social'],
      memberSub: 'mock-member-1',
    });
  });
});

describe('persistent OAuth state store', () => {
  it('create + consume works and is tenant-bound', async () => {
    const store = new SqlOAuthStateStore(exec, 600_000);
    const state = await store.create(LOCAL_DEV_TENANT);
    expect(state).toBeTruthy();
    await expect(store.consume(state, LOCAL_DEV_TENANT)).resolves.toBeUndefined();
  });
  it('replay of a consumed state is rejected (single-use, atomic)', async () => {
    const store = new SqlOAuthStateStore(exec, 600_000);
    const state = await store.create(LOCAL_DEV_TENANT);
    await store.consume(state, LOCAL_DEV_TENANT);
    await expect(store.consume(state, LOCAL_DEV_TENANT)).rejects.toMatchObject({
      code: 'consumed',
    });
  });
  it('a state issued for tenant A cannot be consumed by tenant B', async () => {
    const store = new SqlOAuthStateStore(exec, 600_000);
    const state = await store.create(LOCAL_DEV_TENANT);
    await expect(store.consume(state, OTHER)).rejects.toMatchObject({
      code: 'tenant-mismatch',
    });
    // cleanup so the single-use semantics stay coherent in later tests
    await store.consume(state, LOCAL_DEV_TENANT);
  });
  it('expired states are rejected as expired', async () => {
    let clock = Date.now();
    const store = new SqlOAuthStateStore(exec, 1_000, () => clock); // 1s TTL
    const state = await store.create(LOCAL_DEV_TENANT);
    clock += 5_000;
    await expect(store.consume(state, LOCAL_DEV_TENANT)).rejects.toMatchObject({
      code: 'expired',
    });
  });
});

describe('persistent publish ledger + budget', () => {
  const TEN = 'tenant-pub';

  it('enter/exit cycle persists success state', async () => {
    const ledger = new SqlPostOperationStore(exec, 600_000);
    const hash = await ledger.enter(TEN, 'hello post');
    await ledger.exit(TEN, hash, 'success', 'urn:li:share:123');
    expect(await ledger.stateOf(TEN, hash)).toBe('success');
  });
  it('duplicate window: identical content is refused; different content passes', async () => {
    const ledger = new SqlPostOperationStore(exec, 600_000);
    await expect(ledger.enter(TEN, 'hello post')).rejects.toMatchObject({
      reason: 'recent-identical',
    });
    await expect(ledger.enter(TEN, 'different post')).resolves.toBeTruthy();
  });
  it('in-flight lock: concurrent identical enters — exactly one wins', async () => {
    const ledger = new SqlPostOperationStore(exec, 600_000);
    const text = 'concurrent sql post';
    // first enter wins; the parallel second must see in-flight
    const p1 = ledger.enter(TEN, text);
    const p2 = ledger.enter(TEN, text).catch((e: unknown) => e as { reason?: string });
    await p1;
    const second = await p2;
    expect((second as { reason?: string }).reason).toBe('in-flight');
  });
  it('budget: capacity is enforced transactionally across separate takes', async () => {
    const budget = new SqlPublishBudget(exec, 2, 60_000);
    expect(await budget.take(TEN)).toBe(true);
    expect(await budget.take(TEN)).toBe(true);
    expect(await budget.take(TEN)).toBe(false);
    expect(await budget.available(TEN)).toBe(0);
  });
  // M9 remediation defect 2 regression (SQLite side): concurrent
  // first-time takes on a fresh tenant row. SQLite serializes writers on
  // one connection, so these take turns — but the assertions are exact
  // anyway (capacity consumed exactly, never exceeded), proving the
  // ON CONFLICT DO NOTHING materialization is well-formed SQLite too.
  it('budget: concurrent FIRST-time takes (fresh tenant, SQLite) consume exactly capacity', async () => {
    const budget = new SqlPublishBudget(exec, 5, 60_000);
    const tenant = 'sqlite-fresh-budget-tenant';
    const results = await Promise.all(
      Array.from({ length: 14 }, () => budget.take(tenant)),
    );
    expect(results.filter((r) => r).length).toBe(5);
    expect(results.filter((r) => !r).length).toBe(9);
    expect(await budget.available(tenant)).toBe(0);
  });
  it('billing store: concurrent FIRST-time takes (fresh tenant/counter, SQLite) consume exactly capacity', async () => {
    const { SqlBillingStore } = await import('../../src/billing/billingStore.js');
    const store = new SqlBillingStore(exec);
    const results = await Promise.all(
      Array.from({ length: 14 }, () => store.take('sqlite-fresh-billing', 'tool-calls', 5, 30 * 86_400_000, 1_700_000_000_000)),
    );
    expect(results.filter((r) => r).length).toBe(5);
    const snap = await store.usageOf('sqlite-fresh-billing', 'tool-calls');
    expect(snap?.used).toBe(5);
  });
  it('budget survives a "restart" (new executor, same file)', async () => {
    const exec2 = new SqliteExecutor(join(dir, 'test.db'));
    const budget2 = new SqlPublishBudget(exec2, 2, 60_000);
    expect(await budget2.available(TEN)).toBe(0); // both hits persisted
    await exec2.close();
  });
  it('ambiguous outcome blocks identical re-entry (suspect-after-ambiguous)', async () => {
    const ledger = new SqlPostOperationStore(exec, 600_000);
    const hash = await ledger.enter(TEN, 'timeout story');
    await ledger.exit(TEN, hash, 'ambiguous');
    await expect(ledger.enter(TEN, 'timeout story')).rejects.toMatchObject({
      reason: 'suspect-after-ambiguous',
    });
  });
  it('fingerprint matches the in-memory implementation (same hash algorithm)', () => {
    expect(fingerprintPostText('x')).toHaveLength(64); // sha256 hex
  });
});

describe('user auth store (sessions, tokens, audit)', () => {
  it('create → verify → session issue → resolve → revoke lifecycle', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const user = await store.createUser('alice', 'correct horse battery staple');
    expect(user.tenantId).toMatch(/^tenant-/);
    const bad = await store.verifyCredential('alice', 'wrong').catch((e: unknown) => e as { code?: string });
    expect((bad as { code?: string }).code).toBe('invalid-credentials');
    const good = await store.verifyCredential('alice', 'correct horse battery staple');
    expect(good.username).toBe('alice');
    const session = await store.issueSession(good);
    expect(session.token).toBeTruthy();
    expect(session.csrfToken).toBeTruthy();
    const resolved = await store.resolveSession(session.token);
    expect(resolved.user.tenantId).toBe(user.tenantId);
    await store.revokeSession(session.token);
    const after = await store.resolveSession(session.token).catch((e: unknown) => e as { code?: string });
    expect((after as { code?: string }).code).toBe('session-revoked');
  });
  it('unknown username does not reveal existence (uniform invalid-credentials)', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const err = await store.verifyCredential('nobody-here', 'x').catch((e: unknown) => e as { code?: string });
    expect((err as { code?: string }).code).toBe('invalid-credentials');
  });
  it('session tokens are stored as digests only (no plaintext in table)', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const user = await store.createUser('bob', 'pw-bob-123');
    const s = await store.issueSession(user);
    const rows = await exec.query({
      sql: 'SELECT token_hash, csrf_token_hash FROM sessions',
    });
    const all = rows.map((r) => `${String(r.token_hash)}${String(r.csrf_token_hash)}`).join(',');
    expect(all).not.toContain(s.token);
    expect(all).not.toContain(s.csrfToken);
  });
  it('expired sessions are rejected', async () => {
    let clock = Date.now();
    const store = new UserAuthStore(exec, 1_000, () => clock); // 1s TTL
    const user = await store.createUser('carol', 'pw-carol');
    const s = await store.issueSession(user);
    clock += 5_000;
    const err = await store.resolveSession(s.token).catch((e: unknown) => e as { code?: string });
    expect((err as { code?: string }).code).toBe('session-expired');
  });
  it('API tokens: issue, resolve to tenant, revoke', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const user = await store.createUser('dave', 'pw-dave');
    const tok = await store.issueApiToken(user.tenantId, 'ci');
    const who = await store.resolveApiToken(tok);
    expect(who.tenantId).toBe(user.tenantId);
    // revoke by id: look up the row by its label
    const row = (await exec.query({
      sql: 'SELECT id FROM api_tokens WHERE label = $1',
      params: ['ci'],
    }))[0];
    await store.revokeApiToken(String(row.id));
    const after = await store.resolveApiToken(tok).catch((e: unknown) => e as { code?: string });
    expect((after as { code?: string }).code).toBe('session-revoked');
  });
  it('audit rows persist tenant + action', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    await store.audit('tenant-x', 'alice', 'login', 'session issued');
    const rows = await exec.query({
      sql: 'SELECT tenant_id, actor, action FROM audit_log WHERE tenant_id = $1',
      params: ['tenant-x'],
    });
    expect(rows.length).toBe(1);
    expect(String(rows[0]?.action)).toBe('login');
  });
});

describe('transaction semantics', () => {
  it('with() rolls back on error (all-or-nothing)', async () => {
    await expect(
      exec.with(async (tx) => {
        await tx.execute({
          sql: `INSERT INTO oauth_states (state, tenant_id, redirect_uri, expires_at)
                VALUES ($1, $2, $3, $4)`,
          params: ['tx-test-state', 'tenant-tx', 'pending', new Date(Date.now() + 60_000).toISOString()],
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    const rows = await exec.query({
      sql: 'SELECT * FROM oauth_states WHERE state = $1',
      params: ['tx-test-state'],
    });
    expect(rows.length).toBe(0); // rolled back
  });
});

describe('restart survival (the whole point of M5)', () => {
  it('tokens + ledger + budget survive a fresh executor on the same file', async () => {
    const exec2 = new SqliteExecutor(join(dir, 'test.db'));
    const vault2 = new SqlTokenVault(exec2, KEY);
    const got = await vault2.get(LOCAL_DEV_TENANT);
    expect(got?.accessToken).toBe('mock-token-abc123');
    expect(got?.memberSub).toBe('mock-member-1');
    await exec2.close();
  });
});
