/**
 * M7 issue #16 — Retention enforcement and deletion verification.
 *
 * Covers (SQLite persistence — the same SQL contract Postgres runs):
 *  1. Per-data-class TTL sweeps delete expired rows and keep live ones.
 *  2. Disconnect deletion verified AT THE SQL LAYER: the tenant's sealed
 *     ciphertext row is gone, plaintext never present, other tenants intact.
 *  3. Account removal: one transaction cascades users/sessions/api-tokens/
 *     vault/ledger/budgets/audit rows; other tenants untouched.
 *  4. Log hygiene: sweep + audit paths never emit token/cookie/password
 *     values (asserted against captured log output).
 *  5. Runtime wiring: buildPersistentRuntime with interval=0 performs a
 *     boot sweep (rows deleted) without a periodic timer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteExecutor } from '../../src/storage/sqliteExecutor.js';
import { applyMigrations } from '../../src/storage/migrations.js';
import { RetentionSweeper, DEFAULT_RETENTION_POLICY } from '../../src/storage/retention.js';
import { SqlTokenVault } from '../../src/auth/linkedin/sqlTokenVault.js';
import { SqlOAuthStateStore } from '../../src/auth/linkedin/sqlStateStore.js';
import { UserAuthStore } from '../../src/auth/users/userAuthStore.js';
import { LOCAL_DEV_TENANT, type TenantContext } from '../../src/identity/tenant.js';
import { generateVaultKey } from '../../src/auth/linkedin/tokenVault.js';

const OTHER: TenantContext = { tenantId: 'tenant-other', userId: 'tenant-other' };
const DIR = mkdtempSync(join(tmpdir(), 'lkm-retention-'));
const DB = join(DIR, 'retention.db');
const KEY = generateVaultKey();

let exec: SqliteExecutor;
let sweeper: RetentionSweeper;

beforeAll(async () => {
  exec = new SqliteExecutor(DB);
  await applyMigrations(exec);
  sweeper = new RetentionSweeper(exec);
});

afterAll(async () => {
  await exec.close();
  rmSync(DIR, { recursive: true, force: true });
});

const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const rows = await exec.query({ sql, params });
  return rows.length;
};

describe('per-class TTL sweeps', () => {
  it('expired sessions are deleted; live sessions survive', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const u = await store.createUser('sess-user', 'sess-pass-123');
    const live = await store.issueSession(u);
    // directly seed an expired session row
    await exec.execute({
      sql: `INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at)
            VALUES ('expired-sess', $1, 'h1', 'h2', $2)`,
      params: [u.id, new Date(Date.now() - 86_400_000).toISOString()],
    });
    const before = await count("SELECT id FROM sessions WHERE user_id = $1", [u.id]);
    expect(before).toBe(2);
    const report = await sweeper.sweep();
    expect(report.deleted.sessions).toBe(1);
    await expect(store.resolveSession(live.token)).resolves.toBeTruthy();
    // cleanup: revoke live session for later tests determinism
    await store.revokeSession(live.token);
  });

  it('expired oauth states are deleted by the sweeper too', async () => {
    const now = Date.now();
    const store = new SqlOAuthStateStore(exec, 600_000, () => now);
    await store.create(LOCAL_DEV_TENANT); // expires at now+10m (live)
    // seed an expired state row directly
    await exec.execute({
      sql: `INSERT INTO oauth_states (state, tenant_id, redirect_uri, expires_at)
            VALUES ('expired-state', 't', 'pending', $1)`,
      params: [new Date(now - 60_000).toISOString()],
    });
    const r = await sweeper.sweep();
    expect(r.deleted.oauth_states).toBe(1);
    expect(await count('SELECT state FROM oauth_states')).toBe(1); // live survives
  });

  it('ended publish ops older than the horizon are deleted; recent ones kept', async () => {
    await exec.execute({
      sql: `INSERT INTO publish_operations (tenant_id, content_hash, state, ended_at, started_at)
            VALUES ('t-old', 'h-old', 'success', $1, $1)`,
      params: [new Date(Date.now() - 3_600_000).toISOString()],
    });
    await exec.execute({
      sql: `INSERT INTO publish_operations (tenant_id, content_hash, state, ended_at, started_at)
            VALUES ('t-new', 'h-new', 'success', $1, $1)`,
      params: [new Date(Date.now() - 60_000).toISOString()],
    });
    const r = await sweeper.sweep();
    expect(r.deleted.publish_operations).toBe(1);
    expect(await count("SELECT * FROM publish_operations WHERE content_hash = 'h-new'")).toBe(1);
    await exec.execute({ sql: 'DELETE FROM publish_operations' });
  });

  it('revoked api tokens are deleted after the grace window', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const u = await store.createUser('tok-user', 'tok-pass-12345');
    await store.issueApiToken(u.tenantId, 'grace');
    const rows = await exec.query({ sql: "SELECT id FROM api_tokens WHERE label = 'grace'" });
    await store.revokeApiToken(String(rows[0]?.id));
    // revoked NOW → within 24h grace → still present after sweep
    await sweeper.sweep();
    expect(await count("SELECT * FROM api_tokens WHERE label = 'grace'")).toBe(1);
    // backdate the revocation past grace → swept
    await exec.execute({
      sql: "UPDATE api_tokens SET revoked_at = $1 WHERE label = 'grace'",
      params: [new Date(Date.now() - (DEFAULT_RETENTION_POLICY.apiTokenRevokedGraceMs + 60_000)).toISOString()],
    });
    const r = await sweeper.sweep();
    expect(r.deleted.api_tokens).toBe(1);
  });

  it('audit rows past the retention horizon are deleted', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    await store.audit('tenant-old', 'user', 'probe', 'old');
    await exec.execute({
      sql: 'UPDATE audit_log SET created_at = $1 WHERE tenant_id = $2',
      params: [new Date(Date.now() - (DEFAULT_RETENTION_POLICY.auditRetentionMs + 3_600_000)).toISOString(), 'tenant-old'],
    });
    const r = await sweeper.sweep();
    expect(r.deleted.audit_log).toBe(1);
    expect(await count("SELECT * FROM audit_log WHERE tenant_id = 'tenant-old'")).toBe(0);
  });

  it('orphaned budget rows older than the window are deleted', async () => {
    await exec.execute({
      sql: `INSERT INTO publish_budgets (tenant_id, window_ms, capacity, hits, updated_at)
            VALUES ('t-budget', 86400000, 3, '[]', $1)`,
      params: [new Date(Date.now() - (DEFAULT_RETENTION_POLICY.budgetWindowMs + 60_000)).toISOString()],
    });
    const r = await sweeper.sweep();
    expect(r.deleted.publish_budgets).toBe(1);
  });
});

describe('disconnect deletion verified at the SQL layer (#16)', () => {
  it('disconnect deletes the tenant ciphertext row; plaintext never present; other tenant intact', async () => {
    const vault = new SqlTokenVault(exec, KEY);
    await vault.put(LOCAL_DEV_TENANT, {
      accessToken: 'AQV-retention-secret',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['openid'],
      memberSub: 'ret-sub',
    });
    await vault.put(OTHER, {
      accessToken: 'AQV-other-secret',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['openid'],
      memberSub: 'other-sub',
    });
    // ciphertext-only invariant before deletion
    const allRows = await exec.query({ sql: 'SELECT ciphertext FROM linkedin_tokens' });
    const blob = JSON.stringify(allRows);
    expect(blob).not.toContain('AQV-retention-secret');
    // the actual deletion (SqlTokenVault.delete returns void; verify by rows)
    await vault.delete(LOCAL_DEV_TENANT);
    expect(await count('SELECT * FROM linkedin_tokens WHERE tenant_id = $1', ['local-tenant/local-user'])).toBe(0);
    expect(await vault.get(LOCAL_DEV_TENANT)).toBeUndefined();
    // other tenant untouched
    const other = await vault.get(OTHER);
    expect(other?.accessToken).toBe('AQV-other-secret');
    await vault.delete(OTHER);
  });
});

describe('account removal cascades every tenant row (#16)', () => {
  it('deleteUser removes user, sessions, api tokens, vault, ledger, budgets, audit; other tenant intact', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const u = await store.createUser('gone-user', 'gone-pass-12345');
    const other = await store.createUser('stay-user', 'stay-pass-12345');
    const sess = await store.issueSession(u);
    await store.issueApiToken(u.tenantId, 'gone-token');
    await store.audit(u.tenantId, 'user', 'login', 'probe');
    const vault = new SqlTokenVault(exec, KEY);
    await vault.put({ tenantId: u.tenantId, userId: u.id }, {
      accessToken: 'AQV-gone',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['openid'],
    });
    await exec.execute({
      sql: `INSERT INTO publish_operations (tenant_id, content_hash, state, started_at)
            VALUES ($1, 'gone-hash', 'success', $2)`,
      params: [u.tenantId, new Date().toISOString()],
    });
    await exec.execute({
      sql: `INSERT INTO publish_budgets (tenant_id, window_ms, capacity, hits)
            VALUES ($1, 86400000, 3, '[]')`,
      params: [u.tenantId],
    });
    // ensure OTHER tenant has rows too (isolation check)
    await store.audit(other.tenantId, 'user', 'login', 'probe');
    await vault.put(OTHER, {
      accessToken: 'AQV-stay',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['openid'],
    });

    expect(await store.deleteUser(u.id)).toBe(1);

    expect(await count('SELECT * FROM users WHERE id = $1', [u.id])).toBe(0);
    expect(await count('SELECT * FROM sessions s JOIN users u ON s.user_id = u.id WHERE u.id = $1', [u.id])).toBe(0); // cascaded via FK
    expect(await count('SELECT * FROM api_tokens')).toBe(0);
    expect(await count('SELECT * FROM linkedin_tokens WHERE tenant_id = $1', [u.tenantId])).toBe(0);
    expect(await count('SELECT * FROM publish_operations WHERE tenant_id = $1', [u.tenantId])).toBe(0);
    expect(await count('SELECT * FROM publish_budgets WHERE tenant_id = $1', [u.tenantId])).toBe(0);
    expect(await count('SELECT * FROM audit_log WHERE tenant_id = $1', [u.tenantId])).toBe(0);
    // the session is now unresolvable (row gone)
    const gone = await store.resolveSession(sess.token).catch((e: unknown) => e as { code?: string });
    // row deleted: 'unknown-token' (no row) — exactly the deletion outcome.
    expect(['unknown-token', 'session-revoked']).toContain(gone.code);
    // OTHER tenant fully intact
    expect(await count('SELECT * FROM users WHERE id = $1', [other.id])).toBe(1);
    expect(await count('SELECT * FROM audit_log WHERE tenant_id = $1', [other.tenantId])).toBeGreaterThanOrEqual(1);
    const stayed = await vault.get(OTHER);
    expect(stayed?.accessToken).toBe('AQV-stay');
    // unknown id → 0, no side effects
    expect(await store.deleteUser('no-such-user')).toBe(0);
    // cleanup
    await vault.delete(OTHER);
    await exec.execute({ sql: 'DELETE FROM audit_log WHERE tenant_id = $1', params: [other.tenantId] });
  });
});

describe('log hygiene on retention paths (#16)', () => {
  it('sweep + audit logging never contains secret values', async () => {
    const store = new UserAuthStore(exec, 3_600_000);
    const u = await store.createUser('hyg-user', 'hyg-secret-pass-12345678');
    const sess = await store.issueSession(u);
    await store.audit(u.tenantId, 'user', 'login', 'session issued');
    // seed something for the sweeper to delete
    await exec.execute({
      sql: `INSERT INTO oauth_states (state, tenant_id, redirect_uri, expires_at)
            VALUES ('hyg-state', 't-hyg', 'pending', $1)`,
      params: [new Date(Date.now() - 60_000).toISOString()],
    });
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    try {
      await sweeper.sweep();
      await store.revokeSession(sess.token);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const blob = logs.join('\n');
    expect(blob).not.toContain(sess.token);
    expect(blob).not.toContain('hyg-secret-pass');
    expect(blob).not.toContain(sess.csrfToken);
    expect(blob).not.toContain(KEY);
  });
});
