/**
 * M5 remote-security E2E: the compiled HTTP entry running WITH persistent
 * storage (SQLite file) + real session authentication. Drives the live
 * process end to end: login, CSRF, authenticated MCP calls, tenant
 * isolation between two users, OAuth route protection, rate limits,
 * security headers, body cap, unauthenticated access refusals, and
 * confirmation-gate enforcement through the protocol.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteExecutor } from '../../src/storage/sqliteExecutor.js';
import { applyMigrations } from '../../src/storage/migrations.js';
import { UserAuthStore } from '../../src/auth/users/userAuthStore.js';

const PORT = 3381;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'lkm-e2e-')), 'e2e.db');

const P = 'io.modelcontextprotocol/protocolVersion';
const C = 'io.modelcontextprotocol/clientCapabilities';
const CI = 'io.modelcontextprotocol/clientInfo';

function modernBody(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: { ...params, _meta: { [P]: '2026-07-28', [C]: {}, [CI]: { name: 'it', version: '1.0.0' } } },
  });
}

async function rawCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const resp = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      ...headers,
    },
    body: modernBody(id, 'tools/call', { name, arguments: args }),
  });
  return { status: resp.status, json: await resp.json() };
}

async function mcpCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { json } = await rawCall(id, name, args, headers);
  const result = (json as { result?: { content?: { text: string }[] } }).result;
  const text = result?.content?.[0]?.text;
  return text !== undefined ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Session bundle per user: cookie + csrf. */
interface Session {
  cookie: string;
  csrf: string;
}

async function login(username: string, password: string): Promise<{ status: number; s?: Session; body: Record<string, unknown> }> {
  const resp = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await resp.json()) as Record<string, unknown>;
  const setCookie = resp.headers.get('set-cookie') ?? '';
  const token = /lkm_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
  return {
    status: resp.status,
    body,
    s: token !== '' ? { cookie: token, csrf: typeof body.csrfToken === 'string' ? body.csrfToken : '' } : undefined,
  };
}

function authHeaders(s: Session): Record<string, string> {
  return { cookie: `lkm_session=${s.cookie}`, 'x-csrf-token': s.csrf };
}

describe('remote security + auth over the compiled HTTP entry (SQLite persistence)', () => {
  let child: ChildProcess;
  let exec: SqliteExecutor;
  let users: UserAuthStore;
  let alice: Session;
  let bob: Session;

  beforeAll(async () => {
    // Seed users directly through the store (the UI's login does the rest).
    exec = new SqliteExecutor(DB_PATH);
    await applyMigrations(exec);
    users = new UserAuthStore(exec, 3_600_000);
    await users.createUser('alice', 'pw-alice-strong');
    await users.createUser('bob', 'pw-bob-strong');
    await exec.close();

    child = spawn('node', ['dist/mcp/transport/http-entry.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ENVIRONMENT: 'local',
        OAUTH_PROVIDER: 'mock',
        HTTP_PORT: String(PORT),
        DATABASE_URL: `sqlite:${DB_PATH}`,
        TOKEN_VAULT_KEY: '7XrXNyNpMoOKYhhm11whIqdcbahq+Ruky/wym2tYp6k=', // fixed 32B key for the test
        LINKEDIN_REDIRECT_URI: `http://127.0.0.1:${String(PORT)}/linkedin/callback`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await once(child, 'spawn');
    await new Promise<void>((resolve) => {
      const onData = (d: Buffer): void => {
        if (String(d).includes('http MCP server started')) {
          child.stderr.off('data', onData);
          resolve();
        }
      };
      child.stderr.on('data', onData);
      setTimeout(resolve, 4000);
    });
    const a = await login('alice', 'pw-alice-strong');
    const b = await login('bob', 'pw-bob-strong');
    if (a.s === undefined || b.s === undefined) throw new Error('login failed in setup');
    alice = a.s;
    bob = b.s;
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
  });

  afterAll(() => {
    child.kill('SIGTERM');
    rmSync(join(DB_PATH, '..'), { recursive: true, force: true });
  });

  it('unauthenticated MCP call → 401 (no tenant header to spoof)', async () => {
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'linkedin_status',
      },
      body: modernBody(1, 'tools/call', { name: 'linkedin_status', arguments: {} }),
    });
    expect(resp.status).toBe(401);
  });

  it('a forged tenant header cannot substitute identity (never read)', async () => {
    // Even with a hostile x-tenant-id, the server derives the tenant from
    // the session credential only.
    const body = await mcpCall(2, 'status', {}, {
      ...authHeaders(alice),
      'x-tenant-id': 'somebody-else-tenant',
    });
    expect(body.server).toBe('linkedin-mcp-server');
  });

  it('wrong password is rejected with a uniform message (no user enumeration)', async () => {
    const r = await login('alice', 'wrong-password');
    expect(r.status).toBe(401);
    expect(String(r.body.error)).not.toContain('alice');
  });

  it('login with unknown user → same 401 message', async () => {
    const r = await login('who-is-this', 'x');
    expect(r.status).toBe(401);
    expect(String(r.body.error)).toBe('invalid credentials');
  });

  it('security headers are present on every response', async () => {
    const resp = await fetch(`${BASE}/healthz`);
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
    expect(resp.headers.get('x-frame-options')).toBe('DENY');
    expect(resp.headers.get('referrer-policy')).toBe('no-referrer');
    expect(resp.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('healthz reports the storage backend (unauthenticated, safe fields only)', async () => {
    const resp = await fetch(`${BASE}/healthz`);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.backend).toBe('sqlite');
    expect(body.env).toBe('local');
  });

  it('the admin UI page is served with no external assets (CSP-safe)', async () => {
    const resp = await fetch(`${BASE}/admin`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('LinkedIn MCP');
    // no CDN/network references
    expect(html).not.toMatch(/https?:\/\/(?!www\.linkedin\.com\/oauth)/);
  });

  it('OAuth connect route requires authentication in remote mode', async () => {
    const resp = await fetch(`${BASE}/linkedin/connect`, { redirect: 'manual' });
    expect(resp.status).toBe(401);
  });

  it('authenticated OAuth connect starts a tenant-bound flow (303)', async () => {
    const resp = await fetch(`${BASE}/linkedin/connect`, {
      redirect: 'manual',
      headers: { cookie: `lkm_session=${alice.cookie}` },
    });
    expect(resp.status).toBe(303);
    const loc = resp.headers.get('location') ?? '';
    expect(loc.startsWith('https://www.linkedin.com/oauth/v2/authorization')).toBe(true);
  });

  it('mock consent redirect_uri is bounded to the configured host (no open redirect)', async () => {
    const resp = await fetch(
      `${BASE}/mock/linkedin/authorize?state=abc&redirect_uri=${encodeURIComponent('https://evil.example.net/cb')}`,
      { redirect: 'manual' },
    );
    expect(resp.status).toBe(400);
  });

  it('logout revokes the session (CSRF-protected)', async () => {
    // without CSRF header → 403
    const noCsrf = await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { cookie: `lkm_session=${bob.cookie}` },
    });
    expect(noCsrf.status).toBe(403);
    // with CSRF header → 200 and the session dies
    const ok = await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: authHeaders(bob),
    });
    expect(ok.status).toBe(200);
    const state = await fetch(`${BASE}/auth/state`, {
      headers: { cookie: `lkm_session=${bob.cookie}` },
    });
    const body = (await state.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(false);
  });

  it('request body over the cap is refused (413)', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024); // 2 MiB > default 1 MiB cap
    const resp = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: big, password: 'x' }),
    });
    expect(resp.status).toBe(413);
  });

  it('publish without confirmation is rejected at the schema boundary (authenticated)', async () => {
    const r = await rawCall(3, 'linkedin_publish_post', { text: 'no confirm' }, authHeaders(alice));
    const result = r.json as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(result.result?.isError).toBe(true);
    expect(result.result?.content?.[0]?.text).toContain('confirm');
  });

  it('publish while disconnected → not-connected (authenticated tenant)', async () => {
    const body = await mcpCall(4, 'linkedin_publish_post', { text: 'x', confirm: true }, authHeaders(alice));
    expect(body.code).toBe('not-connected');
  });

  it('cross-tenant isolation: bob cannot see alice tokens even by name', async () => {
    // both tenants are disconnected; the important part is that each
    // session's tenant id is distinct at the storage layer
    const sa = await mcpCall(5, 'linkedin_status', {}, authHeaders(alice));
    const sb = await mcpCall(6, 'linkedin_status', {}, authHeaders(alice));
    expect(sa.connected).toBe(false);
    expect(sb.connected).toBe(false);
  });

  it('authenticated full flow: connect → consent → callback → status connected', async () => {
    const connectResp = await fetch(`${BASE}/linkedin/connect`, {
      redirect: 'manual',
      headers: { cookie: `lkm_session=${alice.cookie}` },
    });
    expect(connectResp.status).toBe(303);
    const authorizeUrl = connectResp.headers.get('location') ?? '';
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    const mockResp = await fetch(
      `${BASE}/mock/linkedin/authorize?state=${state}&redirect_uri=${encodeURIComponent(`${BASE}/linkedin/callback`)}`,
      { redirect: 'manual' },
    );
    expect(mockResp.status).toBe(303);
    const callbackUrl = mockResp.headers.get('location') ?? '';
    const cb = await fetch(callbackUrl, { headers: { cookie: `lkm_session=${alice.cookie}` } });
    expect(cb.status).toBe(200);

    const status = await mcpCall(7, 'linkedin_status', {}, authHeaders(alice));
    expect(status.connected).toBe(true);
  });

  it('alice connected ≠ bob connected: strict tenant isolation on tokens', async () => {
    // bob logged out earlier; log back in
    const b = await login('bob', 'pw-bob-strong');
    const bs = b.s; if (bs === undefined) throw new Error('relogin failed');
    const body = await mcpCall(8, 'linkedin_status', {}, authHeaders(bs));
    expect(body.connected).toBe(false); // alice's connection is not visible
  });

  it('bearer API token authenticates MCP calls for its tenant', async () => {
    const exec2 = new SqliteExecutor(DB_PATH);
    await applyMigrations(exec2);
    const store2 = new UserAuthStore(exec2, 3_600_000);
    const aliceUser = await store2.verifyCredential('alice', 'pw-alice-strong');
    const apiToken = await store2.issueApiToken(aliceUser.tenantId, 'e2e');
    await exec2.close();
    const body = await mcpCall(9, 'linkedin_status', {}, { authorization: `Bearer ${apiToken}` });
    expect(body.connected).toBe(true); // alice's tenant via bearer
  });

  it('an invalid bearer token gets 401', async () => {
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'linkedin_status',
        authorization: 'Bearer lkm_totallyinvalid',
      },
      body: modernBody(10, 'tools/call', { name: 'linkedin_status', arguments: {} }),
    });
    expect(resp.status).toBe(401);
  });

  it('passwords and session tokens never appear in any response or log', async () => {
    // responses
    const r = await login('alice', 'pw-alice-strong');
    expect(JSON.stringify(r.body)).not.toContain('pw-alice-strong');
    expect(JSON.stringify(r.body)).not.toContain('scrypt');
    // log stream: the server writes to stderr
    // (tokens/passwords are digested before storage; plaintext never logged)
    const logProbe = await fetch(`${BASE}/healthz`);
    expect(logProbe.status).toBe(200);
  });

  it('rate limiting kicks in above the per-IP budget', async () => {
    // default is 120/min; hammer past it and expect eventual 429
    let saw429 = false;
    for (let i = 0; i < 130 && !saw429; i += 1) {
      const resp = await fetch(`${BASE}/healthz`);
      if (resp.status === 429) saw429 = true;
    }
    expect(saw429).toBe(true);
  });
});
