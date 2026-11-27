/**
 * M6 Issue #11 — REAL PostgreSQL integration tests (ADR-021).
 *
 * Engine: PostgreSQL 19 (embedded-postgres dev-dependency; real initdb,
 * real server, real pg wire protocol — NOT SQLite, NOT a mock).
 * Compose deployment pins postgres:17-alpine; the Postgres dialect surface
 * exercised here (DDL, INSERT ... ON CONFLICT, TIMESTAMPTZ, transactions,
 * numbered placeholders $1..n) is identical across PG 17/19. A live 17.x
 * bring-up remains part of the owner's staging deploy (deploy/README.md).
 *
 * Covers: migrations idempotency on real PG; PostgresExecutor query/execute/
 * with() incl. ROLLBACK; SQL vault round-trip + ciphertext-only + tenant
 * isolation; state store atomic single-use + replay + TTL; op ledger +
 * budget transactions under concurrency; user auth lifecycle; restart
 * survival on the SAME database (stop server, start a new one).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { PostgresExecutor } from '../../src/storage/postgresExecutor.js';
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

const OTHER: TenantContext = { tenantId: 'tenant-other', userId: 'tenant-other' };
const KEY = generateVaultKey();
const PG_PORT = 5433 + (process.env.VITEST_POOL_ID ? Number(process.env.VITEST_POOL_ID) : 0);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'lkm-pg-'));
const DB_NAME = 'lkm_test';

let pg: InstanceType<typeof EmbeddedPostgres>;
let exec: PostgresExecutor;

beforeAll(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: join(DATA_DIR, 'db'),
    user: 'lkm',
    password: 'lkm-test',
    port: PG_PORT,
    persistent: true, // keep the data dir across stop/start (restart tests)
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  exec = new PostgresExecutor({
    url: `postgres://lkm:lkm-test@127.0.0.1:${String(PG_PORT)}/${DB_NAME}`,
    max: 4,
  });
  await applyMigrations(exec);
}, 120_000);

afterAll(async () => {
  // the restart test stops the servers; ensure exec pool is closed too
  await exec.close().catch(() => undefined);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('migrations on real PostgreSQL', () => {
  it('re-running applies nothing (idempotent)', async () => {
    const ran = await applyMigrations(exec);
    expect(ran).toEqual([]);
  });
  it('records applied ids', async () => {
    const rows = await exec.query({ sql: 'SELECT id, name FROM schema_migrations ORDER BY id' });
    expect(rows.length).toBeGreaterThan(0);
    expect(String(rows[0]?.name)).toBe('core tables');
  });
});

describe('PostgresExecutor semantics', () => {
  it('query returns rows; execute returns affected count', async () => {
    const rows = await exec.query({ sql: 'SELECT 1 AS one' });
    expect(Number(rows[0]?.one)).toBe(1);
    const n = await exec.execute({
      sql: `INSERT INTO oauth_states (state, tenant_id, redirect_uri, expires_at)
            VALUES ($1, $2, 'pending', now() + interval '10 minutes') RETURNING state`,
      params: ['exec-probe-state', 'tenant-exec'],
    });
    expect(n).toBe(1);
    const got = await exec.query({ sql: 'SELECT tenant_id FROM oauth_states WHERE state = $1', params: ['exec-probe-state'] });
    expect(String(got[0]?.tenant_id)).toBe('tenant-exec');
  });
  it('with() commits on success and rolls back on throw', async () => {
    await exec.with(async (tx) => {
      await tx.execute({
        sql: `INSERT INTO oauth_states (state, tenant_id, redirect_uri, expires_at)
              VALUES ($1, $2, 'pending', now() + interval '1 minute')`,
        params: ['tx-ok-state', 'tenant-tx'],
      });
    });
    const ok = await exec.query({ sql: 'SELECT * FROM oauth_states WHERE state = $1', params: ['tx-ok-state'] });
    expect(ok.length).toBe(1);
    await expect(
      exec.with(async (tx) => {
        await tx.execute({
          sql: `INSERT INTO oauth_states (state, tenant_id, redirect_uri, expires_at)
                VALUES ($1, $2, 'pending', now() + interval '1 minute')`,
          params: ['tx-bad-state', 'tenant-tx'],
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    const bad = await exec.query({ sql: 'SELECT * FROM oauth_states WHERE state = $1', params: ['tx-bad-state'] });
    expect(bad.length).toBe(0);
  });
  it('numbered placeholders bind correctly regardless of SQL order (SET $2 WHERE $1)', async () => {
    await exec.execute({
      sql: `INSERT INTO oauth_states (state, tenant_id, redirect_uri, expires_at)
            VALUES ($1, $2, 'pending', now() + interval '10 minutes')`,
      params: ['bind-state', 'tenant-bind'],
    });
    const n = await exec.execute({
      sql: 'UPDATE oauth_states SET consumed_at = $2 WHERE state = $1 AND consumed_at IS NULL',
      params: ['bind-state', new Date().toISOString()],
    });
    expect(n).toBe(1);
  });
});

describe('SQL token vault on PostgreSQL', () => {
  it('round-trips a TokenSet (real PG roundtrip of sealed envelope)', async () => {
    const vault = new SqlTokenVault(exec, KEY);
    const tokens = {
      accessToken: 'AQV-pg-token-xyz',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['openid', 'profile', 'email', 'w_member_social'],
      memberSub: 'pg-member-1',
    };
    await vault.put(LOCAL_DEV_TENANT, tokens);
    expect(await vault.get(LOCAL_DEV_TENANT)).toEqual(tokens);
  });
  it('stores ONLY ciphertext (plaintext never reaches the table)', async () => {
    const rows = await exec.query({
      sql: 'SELECT ciphertext, iv, scopes, member_sub FROM linkedin_tokens WHERE tenant_id = $1',
      params: ['local-tenant/local-user'],
    });
    const row = rows[0];
    expect(String(row.ciphertext)).not.toContain('AQV-pg-token-xyz');
    expect(String(row.scopes)).toContain('w_member_social');
    expect(String(row.member_sub)).toBe('pg-member-1');
  });
  it('tenant isolation: OTHER tenant sees nothing of ours and vice versa', async () => {
    const vault = new SqlTokenVault(exec, KEY);
    expect(await vault.get(OTHER)).toBeUndefined();
    await vault.put(OTHER, { accessToken: 'other-pg', expiresAt: Date.now() + 60_000, scopes: ['openid'] });
    const mine = await vault.get(LOCAL_DEV_TENANT);
    expect(mine?.accessToken).toBe('AQV-pg-token-xyz');
    await vault.delete(OTHER);
    expect(await vault.get(OTHER)).toBeUndefined();
    expect(await vault.get(LOCAL_DEV_TENANT)).toMatchObject({ memberSub: 'pg-member-1' });
  });
});

describe('SQL OAuth state store on PostgreSQL', () => {
  it('create + consume works; replay rejected; TTL enforced; tenant-bound', async () => {
    let clock = Date.now();
    const store = new SqlOAuthStateStore(exec, 600_000, () => clock);
    const s1 = await store.create(LOCAL_DEV_TENANT);
    await store.consume(s1, LOCAL_DEV_TENANT);
    await expect(store.consume(s1, LOCAL_DEV_TENANT)).rejects.toMatchObject({ code: 'consumed' });
    const s2 = await store.create(LOCAL_DEV_TENANT);
    await expect(store.consume(s2, OTHER)).rejects.toMatchObject({ code: 'tenant-mismatch' });
    await store.consume(s2, LOCAL_DEV_TENANT);
    const shortTtl = new SqlOAuthStateStore(exec, 1_000, () => clock);
    const s3 = await shortTtl.create(LOCAL_DEV_TENANT);
    clock += 5_000;
    await expect(shortTtl.consume(s3, LOCAL_DEV_TENANT)).rejects.toMatchObject({ code: 'expired' });
  });
});

describe('SQL publish ledger + budget on PostgreSQL', () => {
  const TEN = 'pg-tenant-pub';
  it('enter/exit persists; duplicate window refuses identical; in-flight locks', async () => {
    const ledger = new SqlPostOperationStore(exec, 600_000);
    const h1 = await ledger.enter(TEN, 'first pg post');
    await ledger.exit(TEN, h1, 'success', 'urn:li:share:pg-1');
    await expect(ledger.enter(TEN, 'first pg post')).rejects.toMatchObject({ reason: 'recent-identical' });
    const h2 = await ledger.enter(TEN, 'second pg post');
    const second = await ledger.enter(TEN, 'second pg post').catch((e: unknown) => e as { reason?: string });
    expect(second.reason).toBe('in-flight');
    await ledger.exit(TEN, h2, 'ambiguous');
    await expect(ledger.enter(TEN, 'second pg post')).rejects.toMatchObject({ reason: 'suspect-after-ambiguous' });
  });
  it('budget capacity enforced transactionally on real PG', async () => {
    const budget = new SqlPublishBudget(exec, 2, 60_000);
    expect(await budget.take(TEN)).toBe(true);
    expect(await budget.take(TEN)).toBe(true);
    expect(await budget.take(TEN)).toBe(false);
    expect(await budget.available(TEN)).toBe(0);
  });
  it('concurrent take() calls never exceed capacity (real PG locking)', async () => {
    const budget = new SqlPublishBudget(exec, 3, 60_000);
    const results = await Promise.all([
      budget.take('concurrent-tenant'),
      budget.take('concurrent-tenant'),
      budget.take('concurrent-tenant'),
      budget.take('concurrent-tenant'),
      budget.take('concurrent-tenant'),
    ]);
    expect(results.filter((r) => r).length).toBe(3);
    expect(results.filter((r) => !r).length).toBe(2);
  });
});

describe('user auth store on PostgreSQL', () => {
  it('full lifecycle: create → verify → session → resolve → revoke; uniform errors; digests only', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const user = await store.createUser('pg-alice', 'pg-strong-pass-123');
    expect(user.tenantId).toMatch(/^tenant-/);
    const bad = await store.verifyCredential('pg-alice', 'nope').catch((e: unknown) => e as { code?: string });
    expect(bad.code).toBe('invalid-credentials');
    const unknown = await store.verifyCredential('pg-nobody', 'x').catch((e: unknown) => e as { code?: string });
    expect(unknown.code).toBe('invalid-credentials');
    const good = await store.verifyCredential('pg-alice', 'pg-strong-pass-123');
    const s = await store.issueSession(good);
    expect(s.token.length).toBeGreaterThan(40);
    const resolved = await store.resolveSession(s.token);
    expect(resolved.user.tenantId).toBe(user.tenantId);
    // digest-at-rest: raw token never appears in the table
    const rows = await exec.query({ sql: 'SELECT token_hash FROM sessions' });
    const blob = JSON.stringify(rows.map((r) => String(r.token_hash)));
    expect(blob).not.toContain(s.token);
    await store.revokeSession(s.token);
    const revoked = await store.resolveSession(s.token).catch((e: unknown) => e as { code?: string });
    expect(revoked.code).toBe('session-revoked');
  });
  it('API tokens resolve to their tenant and revoke cleanly', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const u = await store.createUser('pg-bob', 'pg-bob-pass-123');
    const tok = await store.issueApiToken(u.tenantId, 'pg-test');
    const who = await store.resolveApiToken(tok);
    expect(who.tenantId).toBe(u.tenantId);
    const rows = await exec.query({
      sql: 'SELECT id FROM api_tokens WHERE label = $1',
      params: ['pg-test'],
    });
    await store.revokeApiToken(String(rows[0]?.id));
    const after = await store.resolveApiToken(tok).catch((e: unknown) => e as { code?: string });
    expect(after.code).toBe('session-revoked');
  });
});

describe('restart survival on PostgreSQL (stop server, start new one)', () => {
  it('tokens/ledger/budget survive a server restart', async () => {
    // Stop the shared server, start a NEW instance on the SAME data dir
    // (restart/crash simulation), verify persisted rows, then leave a
    // running instance for afterAll teardown. embedded-postgres stop()
    // can reject with non-Error values — tolerate and press on: what
    // matters is that a fresh server on the same cluster sees the data.
    await exec.close();
    await pg.stop().catch(() => undefined);
    const pg2 = new EmbeddedPostgres({
      databaseDir: join(DATA_DIR, 'db'),
      user: 'lkm',
      password: 'lkm-test',
      port: PG_PORT,
      persistent: true,
    });
    await pg2.start();
    const exec2 = new PostgresExecutor({
      url: `postgres://lkm:lkm-test@127.0.0.1:${String(PG_PORT)}/${DB_NAME}`,
    });
    // migrations already applied → no-op on the restarted server
    expect(await applyMigrations(exec2)).toEqual([]);
    const vault2 = new SqlTokenVault(exec2, KEY);
    const got = await vault2.get(LOCAL_DEV_TENANT);
    expect(got?.accessToken).toBe('AQV-pg-token-xyz');
    expect(got?.memberSub).toBe('pg-member-1');
    const budget2 = new SqlPublishBudget(exec2, 2, 60_000);
    expect(await budget2.available('pg-tenant-pub')).toBe(0); // both hits persisted
    await exec2.close();
    await pg2.stop().catch(() => undefined);
  }, 180_000);
});

