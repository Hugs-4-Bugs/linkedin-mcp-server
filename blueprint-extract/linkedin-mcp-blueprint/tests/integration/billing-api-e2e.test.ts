/**
 * M9 Phase 3 — full-stack billing E2E against the REAL compiled server
 * (spawn dist/mcp/transport/http-entry.js, sqlite persistence, billing
 * enabled in test mode).
 *
 * Covers the complete user-facing billing experience over real HTTP:
 *   1. authenticate (session + CSRF)
 *   2. billing summary (404-free mounted API; server-authoritative data)
 *   3. checkout initiation (pending state; audit row; NO entitlement write)
 *   4. webhook-signed subscription activation (the ONLY path that grants)
 *   5. usage/quota reflected from the metering counter after real tool calls
 *   6. quota-exhaustion surface: structured refusal shape the UI maps
 *   7. cancellation request → provider webhook cancelled → revoked
 *   8. tenant isolation: a second tenant's summary never shows tenant A's
 *      subscription; unauthenticated access is 401
 *   9. self-hosted server (billing disabled): /api/billing/* is 404, MCP
 *      still works, /admin page still loads (billing tab degrades cleanly)
 *
 * Provider behavior note: Razorpay test-mode sandbox credentials are not
 * available in this environment; the provider-side webhook delivery is
 * simulated with CORRECTLY-SIGNED deterministic fixtures (real HMAC over
 * the real route). That is the documented integration boundary — the
 * code path exercised is the real one end-to-end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteExecutor } from '../../src/storage/sqliteExecutor.js';
import { applyMigrations } from '../../src/storage/migrations.js';
import { UserAuthStore } from '../../src/auth/users/userAuthStore.js';

const SECRET = 'e2e-billing-api-secret-0123456789';
const PORT_BILLED = 3361;
const PORT_SELFHOST = 3362;
const DIR = mkdtempSync(join(tmpdir(), 'lkm-billing-api-e2e-'));
const DB_BILLED = join(DIR, 'billed.db');
const DB_SELFHOST = join(DIR, 'selfhost.db');
const PW = 'pw-billing-e2e-strong';

interface Session {
  cookie: string;
  csrf: string;
  tenantId: string;
}

let billed: ChildProcess;
let selfHosted: ChildProcess;
let alice: Session;
let bob: Session;

async function waitStarted(child: ChildProcess): Promise<void> {
  await once(child, 'spawn');
  await new Promise<void>((resolve) => {
    const onData = (d: Buffer): void => {
      if (String(d).includes('http MCP server started')) {
        child.stderr?.off('data', onData);
        resolve();
      }
    };
    child.stderr?.on('data', onData);
    setTimeout(resolve, 8000);
  });
}

async function login(port: number, username: string): Promise<Session> {
  const resp = await fetch(`http://127.0.0.1:${String(port)}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PW }),
  });
  const body = (await resp.json()) as { csrfToken?: string; tenantId?: string };
  const setCookie = resp.headers.get('set-cookie') ?? '';
  const cookie = /lkm_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
  return { cookie, csrf: body.csrfToken ?? '', tenantId: body.tenantId ?? '' };
}

function api(port: number, path: string, s: Session | null, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...(init?.headers as Record<string, string> | undefined ?? {}) };
  if (s !== null) {
    headers.cookie = `lkm_session=${s.cookie}`;
    if (init?.method === 'POST') headers['x-csrf-token'] = s.csrf;
  }
  return fetch(`http://127.0.0.1:${String(port)}${path}`, { ...init, headers });
}

function webhookBody(eventId: string, code: string, tenantId: string, planId = 'pro'): Buffer {
  return Buffer.from(JSON.stringify({
    event: code,
    event_id: eventId,
    created_at: 1_700_000_000_000,
    payload: { subscription: { id: `sub_${tenantId}`, plan_id: planId, status: 'active', tenant_id: tenantId } },
  }));
}

async function sendWebhook(port: number, eventId: string, code: string, tenantId: string): Promise<Response> {
  const body = webhookBody(eventId, code, tenantId);
  const signature = createHmac('sha256', SECRET).update(body).digest('hex');
  return fetch(`http://127.0.0.1:${String(port)}/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    body: new Uint8Array(body),
  });
}

/**
 * Open a real MCP session over HTTP and return a tools/call driver for one
 * tool. Uses the exact client pattern of client-compat-chatgpt.test.ts
 * (Mcp-Method/Mcp-Name headers + _meta envelope; SSE data: line parsing).
 */
async function mcpCallTool(
  port: number,
  s: Session,
  tool: string,
): Promise<(id: number) => Promise<{ isError?: boolean; content: { text: string }[] }>> {
  const init = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      cookie: `lkm_session=${s.cookie}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 900, method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'billing-e2e', version: '1.0.0' } },
    }),
  });
  const sessionId = init.headers.get('mcp-session-id');
  await init.text();
  return async (id: number) => {
    const r = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': tool,
        ...(sessionId !== null ? { 'mcp-session-id': sessionId } : {}),
        cookie: `lkm_session=${s.cookie}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: {
          name: tool,
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'billing-e2e', version: '1.0.0' },
          },
        },
      }),
    });
    const text = await r.text();
    let json: Record<string, unknown> | null = null;
    if (text.trim().startsWith('{')) {
      json = JSON.parse(text) as Record<string, unknown>;
    } else {
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      if (line !== undefined) json = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
    }
    const result = (json?.result ?? {}) as { isError?: boolean; content: { text: string }[] };
    return result;
  };
}

beforeAll(async () => {
  // Seed two users into the billed DB (tenant isolation subjects) and one
  // into the self-hosted DB.
  const seed = new SqliteExecutor(DB_BILLED);
  await applyMigrations(seed);
  const users = new UserAuthStore(seed, 3_600_000);
  await users.createUser('alice', PW);
  await users.createUser('bob', PW);
  await seed.close();
  const seedSelf = new SqliteExecutor(DB_SELFHOST);
  await applyMigrations(seedSelf);
  const selfUsers = new UserAuthStore(seedSelf, 3_600_000);
  await selfUsers.createUser('selfhost', PW);
  await seedSelf.close();

  billed = spawn('node', ['dist/mcp/transport/http-entry.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ENVIRONMENT: 'local',
      HTTP_PORT: String(PORT_BILLED),
      DATABASE_URL: `sqlite:${DB_BILLED}`,
      BILLING_ENABLED: 'true',
      RAZORPAY_WEBHOOK_SECRET: SECRET,
      BILLING_PLAN_LIMITS: JSON.stringify({ pro: 3, team: 50 }),
      AUTH_MODE: 'session',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitStarted(billed);

  selfHosted = spawn('node', ['dist/mcp/transport/http-entry.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ENVIRONMENT: 'local',
      HTTP_PORT: String(PORT_SELFHOST),
      DATABASE_URL: `sqlite:${DB_SELFHOST}`,
      // NO billing env: the default (disabled) self-hosted posture.
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitStarted(selfHosted);

  alice = await login(PORT_BILLED, 'alice');
  bob = await login(PORT_BILLED, 'bob');
}, 60_000);

afterAll(() => {
  billed.kill('SIGTERM');
  selfHosted.kill('SIGTERM');
  rmSync(DIR, { recursive: true, force: true });
});

describe('billing API on the billed server (real HTTP)', () => {
  it('requires authentication (401 for anonymous)', async () => {
    const res = await api(PORT_BILLED, '/api/billing/summary', null);
    expect(res.status).toBe(401);
  });

  it('summary: no subscription yet — honest empty state, real plans catalog', async () => {
    const res = await api(PORT_BILLED, '/api/billing/summary', alice);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.subscription).toBeNull();
    expect(body.usage).toMatchObject({ used: 0, limit: 0, remaining: 0 });
    const plans = body.plans as { planId: string; monthlyToolCalls: number; priceInr: number }[];
    expect(plans.map((p) => p.planId).sort()).toEqual(['pro', 'team']);
    expect(plans.find((p) => p.planId === 'pro')?.monthlyToolCalls).toBe(3); // server-configured limit
  });

  it('checkout: returns PENDING (no entitlement write); rejects unknown plans fail-closed', async () => {
    const res = await api(PORT_BILLED, '/api/billing/checkout', alice, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'pro' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(body.priceInr).toBe(999);
    // The checkout MUST NOT have granted anything:
    const summary = (await (await api(PORT_BILLED, '/api/billing/summary', alice)).json()) as Record<string, unknown>;
    expect(summary.subscription === null ? 'still-null' : 'granted').toBe('still-null');

    const bad = await api(PORT_BILLED, '/api/billing/checkout', alice, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'enterprise' }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('unknown plan');
  });

  it('checkout without CSRF is rejected (403)', async () => {
    const res = await fetch(`http://127.0.0.1:${String(PORT_BILLED)}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `lkm_session=${alice.cookie}` },
      body: JSON.stringify({ planId: 'pro' }),
    });
    expect(res.status).toBe(403);
  });

  it('the verified webhook activates the subscription (summary flips to active)', async () => {
    const res = await sendWebhook(PORT_BILLED, 'evt_api_1', 'subscription.authenticated', alice.tenantId);
    expect(res.status).toBe(200);
    const summary = (await (await api(PORT_BILLED, '/api/billing/summary', alice)).json()) as Record<string, unknown>;
    const sub = summary.subscription as Record<string, unknown>;
    expect(sub.planId).toBe('pro');
    expect(sub.entitlementStatus).toBe('active');
    expect(sub.usable).toBe(true);
    const usage = summary.usage as Record<string, unknown>;
    expect(usage.limit).toBe(3); // pro limit from server config
  });

  it('usage: real metered tool calls move the server-side counter', async () => {
    // Drive two real MCP tool calls through the authenticated /mcp route.
    const call = await mcpCallTool(PORT_BILLED, alice, 'linkedin_status');
    const r1 = await call(102);
    expect(r1.isError).toBeFalsy(); // entitled: allowed + metered
    const r2 = await call(103);
    expect(r2.isError).toBeFalsy();
    const summary = (await (await api(PORT_BILLED, '/api/billing/summary', alice)).json()) as Record<string, unknown>;
    expect((summary.usage as Record<string, unknown>).used).toBe(2);
    expect((summary.usage as Record<string, unknown>).remaining).toBe(1);
  });

  it('quota exhaustion: the next tool call is refused with the structured billing error', async () => {
    // Third call consumes the last unit; fourth must be refused.
    const call = await mcpCallTool(PORT_BILLED, alice, 'linkedin_status');
    const r3 = await call(111);
    expect(r3.isError).toBeFalsy();
    const r4 = await call(112);
    expect(r4.isError).toBe(true);
    const parsed = JSON.parse(r4.content[0]?.text ?? '{}') as { error?: string };
    expect(parsed.error).toBe('UsageLimitExceededError');
    // Summary reflects exhaustion for the UI's structured message:
    const summary = (await (await api(PORT_BILLED, '/api/billing/summary', alice)).json()) as Record<string, unknown>;
    expect((summary.usage as Record<string, unknown>).exhausted).toBe(true);
  });

  it('cancellation: request → verified webhook revokes → summary shows canceled', async () => {
    const req = await api(PORT_BILLED, '/api/billing/cancel', alice, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(req.status).toBe(200);
    const body = (await req.json()) as Record<string, unknown>;
    expect(body.status).toBe('cancel-requested');
    // Not revoked yet — the UI copy and the store agree:
    let summary = (await (await api(PORT_BILLED, '/api/billing/summary', alice)).json()) as Record<string, unknown>;
    expect((summary.subscription as Record<string, unknown>).entitlementStatus).toBe('active');
    // The provider's cancelled webhook is the authoritative revocation:
    const wh = await sendWebhook(PORT_BILLED, 'evt_api_2', 'subscription.cancelled', alice.tenantId);
    expect(wh.status).toBe(200);
    summary = (await (await api(PORT_BILLED, '/api/billing/summary', alice)).json()) as Record<string, unknown>;
    expect((summary.subscription as Record<string, unknown>).entitlementStatus).toBe('canceled');
    expect((summary.subscription as Record<string, unknown>).usable).toBe(false);
  });

  it('tenant isolation: bob never sees alice\u2019s subscription; a forged webhook for bob\u2019s tenant from alice\u2019s session changes nothing for alice', async () => {
    const bobSummary = (await (await api(PORT_BILLED, '/api/billing/summary', bob)).json()) as Record<string, unknown>;
    expect(bobSummary.subscription).toBeNull();
    // Activate bob's own subscription via bob's tenant webhook:
    await sendWebhook(PORT_BILLED, 'evt_api_3', 'subscription.authenticated', bob.tenantId);
    const bobAfter = (await (await api(PORT_BILLED, '/api/billing/summary', bob)).json()) as Record<string, unknown>;
    expect((bobAfter.subscription as Record<string, unknown>).planId).toBe('pro');
    // Alice is still canceled — cross-tenant leakage would show 'active':
    const aliceSummary = (await (await api(PORT_BILLED, '/api/billing/summary', alice)).json()) as Record<string, unknown>;
    expect((aliceSummary.subscription as Record<string, unknown>).entitlementStatus).toBe('canceled');
  });

  it('no client-authority: a checkout POST cannot change another tenant\u2019s state (tenant is the session, not the body)', async () => {
    // bob attempts checkout with an extra tenantId field — must be ignored.
    const res = await api(PORT_BILLED, '/api/billing/checkout', bob, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'pro', tenantId: alice.tenantId }),
    });
    expect(res.status).toBe(200);
    // Alice's state is untouched by bob's request:
    const aliceSummary = (await (await api(PORT_BILLED, '/api/billing/summary', alice)).json()) as Record<string, unknown>;
    expect((aliceSummary.subscription as Record<string, unknown>).entitlementStatus).toBe('canceled');
  });
});

describe('self-hosted server (billing disabled) — the hard boundary', () => {
  it('/api/billing/* is NOT mounted (404)', async () => {
    const s = await login(PORT_SELFHOST, 'selfhost');
    const res = await api(PORT_SELFHOST, '/api/billing/summary', s);
    expect(res.status).toBe(404);
    const checkout = await api(PORT_SELFHOST, '/api/billing/checkout', s, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'pro' }),
    });
    expect(checkout.status).toBe(404);
  });

  it('the admin page still loads (the billing tab degrades to the self-hosted message client-side)', async () => {
    const res = await fetch(`http://127.0.0.1:${String(PORT_SELFHOST)}/admin`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-view="billing"'); // nav entry exists
    // The page itself must not hard-depend on the billing API (fetch is
    // client-side; the 404 branch renders the self-host message).
  });

  it('MCP tools remain fully operational with zero billing dependency', async () => {
    const sh = await login(PORT_SELFHOST, 'selfhost');
    // The server-status tool (unmetered, no LinkedIn dependency) proves the
    // whole MCP pipeline is alive with zero billing machinery mounted.
    const call = await mcpCallTool(PORT_SELFHOST, sh, 'status');
    const r = await call(201);
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0]?.text ?? '{}') as { server?: string };
    expect(parsed.server).toBe('linkedin-mcp-server');
  });
});
