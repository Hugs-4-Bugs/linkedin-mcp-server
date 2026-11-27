/**
 * Phase 5b workspace smoke — run the REAL compiled HTTP server as a live
 * process in this workspace (billed, sqlite, Razorpay TEST-mode billing
 * config) and drive the complete user-facing experience over real HTTP:
 *
 *   1. boot + /healthz + /ready + /metrics (M10 surface)
 *   2. login (session + CSRF)
 *   3. billing summary (empty state)
 *   4. checkout → payment-pending (no entitlement write)
 *   5. signed webhook → subscription active (server-authoritative)
 *   6. real MCP tool call (metered) → usage counter moves
 *   7. billing summary shows plan + usage
 *   8. cancellation request → signed cancelled webhook → revoked
 *   9. quota refusal after cancel? (entitlement gate) → structured refusal
 *  10. /admin UI page loads with Billing nav
 *  11. self-hosted second server: /api/billing 404, MCP works
 *  12. graceful SIGTERM shutdown
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteExecutor } from '../dist/storage/sqliteExecutor.js';
import { applyMigrations } from '../dist/storage/migrations.js';
import { UserAuthStore } from '../dist/auth/users/userAuthStore.js';

const SECRET = 'workspace-smoke-secret-0123456789abcdef';
const PORT = 3391;
const PORT_SH = 3392;
const DIR = mkdtempSync(join(tmpdir(), 'lkm-ws-smoke-'));
const DB = join(DIR, 'smoke.db');
const DB_SH = join(DIR, 'selfhost.db');
const PW = 'pw-workspace-smoke-strong';
const PROTO = '2026-07-28';
const CLIENT = { name: 'workspace-smoke', version: '1.0.0' };

let child;
let childSh;
let cookie = '';
let csrf = '';
let tenantId = '';

async function waitStarted(c) {
  await once(c, 'spawn');
  await new Promise((resolve) => {
    const onData = (d) => {
      if (String(d).includes('http MCP server started')) {
        c.stderr?.off('data', onData);
        resolve();
      }
    };
    c.stderr?.on('data', onData);
    setTimeout(resolve, 8000);
  });
}

function api(path, init = {}) {
  const headers = { accept: 'application/json', ...(init.headers || {}) };
  if (cookie) headers.cookie = `lkm_session=${cookie}`;
  if (init.method === 'POST' && csrf) headers['x-csrf-token'] = csrf;
  return fetch(`http://127.0.0.1:${String(PORT)}${path}`, { ...init, headers });
}

async function mcpInitialize() {
  const r = await fetch(`http://127.0.0.1:${String(PORT)}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: `lkm_session=${cookie}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: PROTO, capabilities: {}, clientInfo: CLIENT } }),
  });
  const sid = r.headers.get('mcp-session-id');
  await r.text();
  return sid;
}

async function mcpCall(sessionId, id, tool) {
  const r = await fetch(`http://127.0.0.1:${String(PORT)}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTO, 'Mcp-Method': 'tools/call', 'Mcp-Name': tool,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}), cookie: `lkm_session=${cookie}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: {
        name: tool, arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTO,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': CLIENT,
        },
      },
    }),
  });
  const text = await r.text();
  let json = null;
  if (text.trim().startsWith('{')) json = JSON.parse(text);
  else {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (line) json = JSON.parse(line.slice(5).trim());
  }
  return json?.result ?? {};
}

function webhookBody(eventId, code, tenant, planId = 'pro') {
  return Buffer.from(JSON.stringify({
    event: code, event_id: eventId, created_at: 1_700_000_000_000,
    payload: { subscription: { id: `sub_${tenant}`, plan_id: planId, status: 'active', tenant_id: tenant } },
  }));
}

async function sendWebhook(eventId, code, tenant) {
  const body = webhookBody(eventId, code, tenant);
  const sig = createHmac('sha256', SECRET).update(body).digest('hex');
  return fetch(`http://127.0.0.1:${String(PORT)}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId },
    body: new Uint8Array(body),
  });
}

const ok = (label, cond, detail = '') => {
  if (!cond) throw new Error(`FAIL at: ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  // Seed user into billed DB
  const seed = new SqliteExecutor(DB);
  await applyMigrations(seed);
  const users = new UserAuthStore(seed, 3_600_000);
  await users.createUser('smoker', PW);
  await seed.close();

  child = spawn('node', ['dist/mcp/transport/http-entry.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, ENVIRONMENT: 'local', HTTP_PORT: String(PORT),
      DATABASE_URL: `sqlite:${DB}`, BILLING_ENABLED: 'true',
      RAZORPAY_WEBHOOK_SECRET: SECRET, AUTH_MODE: 'session',
      BILLING_PLAN_LIMITS: JSON.stringify({ pro: 2, team: 50 }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitStarted(child);
  ok('1a. billed server booted (http MCP server started)', true);

  // M10 surface
  const hz = await (await fetch(`http://127.0.0.1:${String(PORT)}/healthz`)).json();
  ok('1b. /healthz liveness', hz.ok === true, `backend=${String(hz.backend)}`);
  const rd = await fetch(`http://127.0.0.1:${String(PORT)}/ready`);
  const rdBody = await rd.json();
  ok('1c. /ready readiness (M10)', rd.status === 200 && rdBody.ok === true, `checkedMs=${String(rdBody.checkedMs)}`);
  const mt = await (await fetch(`http://127.0.0.1:${String(PORT)}/metrics`)).text();
  ok('1d. /metrics Prometheus text (M10)', mt.includes('lkm_http_requests_total') && mt.includes('lkm_process_uptime_seconds'));

  // login
  const login = await fetch(`http://127.0.0.1:${String(PORT)}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoker', password: PW }),
  });
  const lb = await login.json();
  cookie = /lkm_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
  csrf = typeof lb.csrfToken === 'string' ? lb.csrfToken : '';
  tenantId = typeof lb.tenantId === 'string' ? lb.tenantId : '';
  ok('2. login (session+CSRF)', login.status === 200 && cookie !== '' && csrf !== '', `tenant=${tenantId}`);

  // 3. empty summary
  const s0 = await (await api('/api/billing/summary')).json();
  ok('3. billing summary empty state', s0.subscription === null && Array.isArray(s0.plans) && s0.plans.length === 2);

  // 4. checkout pending, no entitlement write
  const co = await api('/api/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: 'pro' }) });
  const cob = await co.json();
  const s0b = await (await api('/api/billing/summary')).json();
  ok('4. checkout → payment-PENDING, no local grant', co.status === 200 && cob.status === 'pending' && s0b.subscription === null, `price=${String(cob.priceInr)}`);

  // 5. signed webhook activates
  const wh = await sendWebhook('evt_ws_1', 'subscription.authenticated', tenantId);
  const s1 = await (await api('/api/billing/summary')).json();
  ok('5. verified webhook → subscription ACTIVE', wh.status === 200 && s1.subscription?.entitlementStatus === 'active' && s1.subscription?.usable === true, `plan=${String(s1.subscription?.planId)} limit=${String(s1.usage?.limit)}`);

  // 6. metered tool call moves usage
  const sid = await mcpInitialize();
  const t1 = await mcpCall(sid, 11, 'linkedin_status');
  const s2 = await (await api('/api/billing/summary')).json();
  ok('6. real MCP tool call metered', t1.isError !== true && s2.usage?.used === 1, `used=${String(s2.usage?.used)}/${String(s2.usage?.limit)}`);

  // quota: second call exhausts, third refused
  await mcpCall(sid, 12, 'linkedin_status');
  const t3 = await mcpCall(sid, 13, 'linkedin_status');
  const refusedErr = JSON.parse(t3.content?.[0]?.text ?? '{}');
  ok('7. quota exhaustion → structured refusal', t3.isError === true && refusedErr.error === 'UsageLimitExceededError');
  const s3 = await (await api('/api/billing/summary')).json();
  ok('7b. summary reports exhausted', s3.usage?.exhausted === true);

  // 8. cancel request → webhook cancelled → revoked
  const cx = await api('/api/billing/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  const cxb = await cx.json();
  const whc = await sendWebhook('evt_ws_2', 'subscription.cancelled', tenantId);
  const s4 = await (await api('/api/billing/summary')).json();
  ok('8. cancel → webhook revoke → canceled', cx.status === 200 && cxb.status === 'cancel-requested' && whc.status === 200 && s4.subscription?.entitlementStatus === 'canceled' && s4.subscription?.usable === false);

  // 9. entitlement gate after revocation
  const t4 = await mcpCall(sid, 14, 'linkedin_status');
  const refusedEnt = JSON.parse(t4.content?.[0]?.text ?? '{}');
  ok('9. revoked → tool refused (EntitlementRequired)', t4.isError === true && refusedEnt.error === 'EntitlementRequiredError');

  // 10. UI page
  const admin = await fetch(`http://127.0.0.1:${String(PORT)}/admin`);
  const html = await admin.text();
  ok('10. /admin UI with Billing nav + billing renderer', admin.status === 200 && html.includes('data-view="billing"') && html.includes('renderBilling'));

  // 11. self-hosted server: no billing env at all
  const seed2 = new SqliteExecutor(DB_SH);
  await applyMigrations(seed2);
  const users2 = new UserAuthStore(seed2, 3_600_000);
  await users2.createUser('shuser', PW);
  await seed2.close();
  childSh = spawn('node', ['dist/mcp/transport/http-entry.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ENVIRONMENT: 'local', HTTP_PORT: String(PORT_SH), DATABASE_URL: `sqlite:${DB_SH}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitStarted(childSh);
  const shLogin = await fetch(`http://127.0.0.1:${String(PORT_SH)}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'shuser', password: PW }),
  });
  const shb = await shLogin.json();
  const shCookie = /lkm_session=([^;]+)/.exec(shLogin.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const shSummary = await fetch(`http://127.0.0.1:${String(PORT_SH)}/api/billing/summary`, { headers: { cookie: `lkm_session=${shCookie}` } });
  ok('11a. self-hosted: /api/billing 404 (unmounted)', shSummary.status === 404);
  const shInit = await fetch(`http://127.0.0.1:${String(PORT_SH)}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: `lkm_session=${shCookie}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'initialize', params: { protocolVersion: PROTO, capabilities: {}, clientInfo: CLIENT } }),
  });
  const shSid = shInit.headers.get('mcp-session-id');
  await shInit.text();
  const shTool = await fetch(`http://127.0.0.1:${String(PORT_SH)}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTO, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'status',
      ...(shSid ? { 'mcp-session-id': shSid } : {}), cookie: `lkm_session=${shCookie}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'status', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTO, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': CLIENT } } }),
  });
  const shToolText = await shTool.text();
  ok('11b. self-hosted: MCP tools fully operational', shTool.status === 200 && shToolText.includes('linkedin-mcp-server'));
  void shb;
  const shMetrics = await (await fetch(`http://127.0.0.1:${String(PORT_SH)}/metrics`)).text();
  ok('11c. self-hosted: /metrics works (zero billing dependency)', shMetrics.includes('lkm_http_requests_total'));

  // 12. graceful shutdown both servers
  child.kill('SIGTERM');
  const exited = await new Promise((res) => {
    child.on('exit', () => res(true));
    setTimeout(() => res(false), 5000);
  });
  childSh.kill('SIGTERM');
  const exitedSh = await new Promise((res) => {
    childSh.on('exit', () => res(true));
    setTimeout(() => res(false), 5000);
  });
  ok('12. graceful SIGTERM shutdown (both servers)', exited && exitedSh);

  rmSync(DIR, { recursive: true, force: true });
  console.log('\nHTTP WORKSPACE SMOKE: ALL CHECKS PASS');
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error('HTTP WORKSPACE SMOKE: FAIL —', err instanceof Error ? err.message : String(err));
    child?.kill('SIGKILL');
    childSh?.kill('SIGKILL');
    process.exit(1);
  },
);
