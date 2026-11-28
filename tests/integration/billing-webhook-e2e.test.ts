/**
 * M9 issue #13 — webhook HTTP route E2E (real server, loopback).
 *
 * Spawns the actual compiled http-entry with BILLING_ENABLED=true +
 * sqlite persistence + a test webhook secret, then drives the real
 * /webhooks/razorpay route over HTTP: valid signature (200), invalid
 * signature (400), duplicate delivery (200 idempotent), and — the
 * self-hosting boundary — a SECOND server with billing disabled where the
 * route must NOT exist (404) and /mcp still works without any billing
 * dependency.
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

const SECRET = 'e2e-webhook-secret-0123456789';
const PORT_BILLED = 3351;
const PORT_SELFHOST = 3352;
const DIR = mkdtempSync(join(tmpdir(), 'lkm-billing-e2e-'));
const DB_BILLED = join(DIR, 'billing.db');
const DB_SELFHOST = join(DIR, 'selfhost.db');
const PW = 'pw-selfhost-strong';

let billed: ChildProcess;
let selfHosted: ChildProcess;
let selfHostCookie = '';
let selfHostCsrf = '';

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
    setTimeout(resolve, 6000);
  });
}

beforeAll(async () => {
  // Seed a user for the self-hosted server so its /mcp can authenticate
  // the way any real deployment would (session + CSRF).
  const seed = new SqliteExecutor(DB_SELFHOST);
  await applyMigrations(seed);
  const users = new UserAuthStore(seed, 3_600_000);
  await users.createUser('selfhost', PW);
  await seed.close();

  billed = spawn('node', ['dist/mcp/transport/http-entry.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ENVIRONMENT: 'local',
      HTTP_PORT: String(PORT_BILLED),
      DATABASE_URL: `sqlite:${DB_BILLED}`,
      BILLING_ENABLED: 'true',
      RAZORPAY_WEBHOOK_SECRET: SECRET,
      AUTH_MODE: 'mock',
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

  const resp = await fetch(`http://127.0.0.1:${String(PORT_SELFHOST)}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'selfhost', password: PW }),
  });
  const body = (await resp.json()) as Record<string, unknown>;
  const setCookie = resp.headers.get('set-cookie') ?? '';
  selfHostCookie = /lkm_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
  selfHostCsrf = typeof body.csrfToken === 'string' ? body.csrfToken : '';
}, 60_000);

afterAll(() => {
  billed.kill('SIGTERM');
  selfHosted.kill('SIGTERM');
  rmSync(DIR, { recursive: true, force: true });
});

function webhookBody(eventId: string, code: string): Buffer {
  return Buffer.from(JSON.stringify({
    event: code,
    event_id: eventId,
    created_at: 1_700_000_000_000,
    payload: { subscription: { id: 'sub_e2e', plan_id: 'pro', status: 'active', tenant_id: 'tenant-e2e' } },
  }));
}

function sign(body: Buffer): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('webhook route on a billed server (real HTTP)', () => {
  it('accepts a correctly signed webhook (200 received)', async () => {
    const body = webhookBody('evt_e2e_1', 'subscription.authenticated');
    const res = await fetch(`http://127.0.0.1:${String(PORT_BILLED)}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_e2e_1' },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('received');
  });

  it('rejects an invalid signature with 400 (never 200)', async () => {
    const body = webhookBody('evt_e2e_2', 'subscription.authenticated');
    const res = await fetch(`http://127.0.0.1:${String(PORT_BILLED)}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': '0'.repeat(64), 'x-razorpay-event-id': 'evt_e2e_2' },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(400);
  });

  it('treats a replayed event as duplicate but still 200 (idempotent)', async () => {
    const body = webhookBody('evt_e2e_1', 'subscription.authenticated');
    const res = await fetch(`http://127.0.0.1:${String(PORT_BILLED)}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_e2e_1' },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('duplicate');
  });

  it('rejects a tampered body (same signature, changed bytes) with 400', async () => {
    const original = webhookBody('evt_e2e_3', 'subscription.cancelled');
    const tampered = Buffer.from(original.toString('utf8').replace('tenant-e2e', 'tenant-evil'));
    const res = await fetch(`http://127.0.0.1:${String(PORT_BILLED)}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(original), 'x-razorpay-event-id': 'evt_e2e_3' },
      body: new Uint8Array(tampered),
    });
    expect(res.status).toBe(400);
  });
});

describe('self-hosted server (billing disabled) — the hard boundary', () => {
  it('the webhook route does NOT exist (404)', async () => {
    const body = webhookBody('evt_e2e_9', 'subscription.authenticated');
    const res = await fetch(`http://127.0.0.1:${String(PORT_SELFHOST)}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_e2e_9' },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(404);
  });

  it('the MCP surface still works with zero billing dependency', async () => {
    // An authenticated tools/list call proves the MCP server is fully
    // alive without any billing/entitlement requirement (self-hosted mode).
    const P = 'io.modelcontextprotocol/protocolVersion';
    const C = 'io.modelcontextprotocol/clientCapabilities';
    const CI = 'io.modelcontextprotocol/clientInfo';
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { [P]: '2026-07-28', [C]: {}, [CI]: { name: 'it', version: '1.0.0' } } },
    });
    const res = await fetch(`http://127.0.0.1:${String(PORT_SELFHOST)}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
        cookie: `lkm_session=${selfHostCookie}`,
        'x-csrf-token': selfHostCsrf,
      },
      body,
    });
    expect(res.status).toBe(200);
  });
});
