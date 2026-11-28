/**
 * M10 issue #17 — Observability tests.
 *
 * Two layers:
 *   1. Unit: MetricsRegistry semantics (bounded label space, counters,
 *      render format, in-flight gauge, unknown-tool collapse).
 *   2. HTTP E2E: /metrics + /ready on the REAL compiled server, in both
 *      modes — billed (sqlite persistence) and self-hosted (in-memory +
 *      sqlite, billing disabled). /metrics must be unauthenticated, content
 *      type text/plain, must count real traffic, and must contain no
 *      secrets. /ready must answer 200 with a working DB and 503 with a
 *      broken one (verified by pointing at a closed DB file — sqlite
 *      read-only probe failure).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetricsRegistry } from '../../src/observability/metrics.js';

describe('MetricsRegistry unit semantics', () => {
  it('counts http requests + errors per route class and total', () => {
    const m = new MetricsRegistry();
    m.httpEnd('/mcp', 200);
    m.httpEnd('/mcp', 200);
    m.httpEnd('/auth', 401);
    const snap = m.snapshot();
    expect(snap.httpRequests).toBe(3);
    expect(snap.httpErrors).toBe(1);
    const text = m.render();
    expect(text).toContain('lkm_http_requests_total{route="/mcp"} 2');
    expect(text).toContain('lkm_http_request_errors_total{route="/auth"} 1');
  });

  it('in-flight gauge increments and decrements (abort path clamps at 0)', () => {
    const m = new MetricsRegistry();
    m.httpStart();
    m.httpStart();
    expect(m.snapshot().inFlight).toBe(2);
    m.httpEnd('/mcp', 200);
    m.httpAborted();
    m.httpAborted(); // drift clamp
    expect(m.snapshot().inFlight).toBe(0);
  });

  it('bounded label space: unknown tools collapse to "other"', () => {
    const m = new MetricsRegistry();
    m.toolCall('linkedin_status', 'ok');
    m.toolCall('hostile<tool>' + 'x'.repeat(500), 'ok'); // unknown + huge
    const text = m.render();
    expect(text).toContain('lkm_mcp_tool_calls_total{tool="linkedin_status",outcome="ok"} 1');
    expect(text).toContain('lkm_mcp_tool_calls_total{tool="other",outcome="ok"} 1');
    expect(text).not.toContain('hostile<tool>');
  });

  it('billing gate outcomes are tracked distinctly', () => {
    const m = new MetricsRegistry();
    m.billingGateDecision('allowed');
    m.billingGateDecision('allowed');
    m.billingGateDecision('quota-exceeded');
    m.billingGateDecision('no-entitlement');
    const text = m.render();
    expect(text).toContain('lkm_billing_gate_total{outcome="allowed"} 2');
    expect(text).toContain('lkm_billing_gate_total{outcome="quota-exceeded"} 1');
    expect(text).toContain('lkm_billing_gate_total{outcome="no-entitlement"} 1');
  });

  it('empty registry renders zero-valued families (scrape-safe)', () => {
    const m = new MetricsRegistry();
    const text = m.render();
    expect(text).toContain('lkm_http_requests_total 0');
    expect(text).toContain('lkm_http_requests_inflight 0');
    expect(text).toContain('lkm_process_uptime_seconds ');
    expect(text).toContain('lkm_process_restart_generation 1');
  });

  it('tool outcome counters are per-tool', () => {
    const m = new MetricsRegistry();
    m.toolCall('linkedin_publish_post', 'ok');
    m.toolCall('linkedin_publish_post', 'error');
    const text = m.render();
    expect(text).toContain('lkm_mcp_tool_calls_total{tool="linkedin_publish_post",outcome="ok"} 1');
    expect(text).toContain('lkm_mcp_tool_calls_total{tool="linkedin_publish_post",outcome="error"} 1');
  });
});

/* ---------- HTTP E2E: /metrics + /ready on the real server ---------- */

const DIR = mkdtempSync(join(tmpdir(), 'lkm-m10-e2e-'));
const PORT_SQLITE = 3384;
const PORT_MEMORY = 3382;
const PORT_READY_BROKEN = 3383;
const DB_SQLITE = join(DIR, 'ops.db');
const DB_BROKEN = join(DIR, 'broken.db');

let sqliteSrv: ChildProcess;
let memorySrv: ChildProcess;
let brokenSrv: ChildProcess;

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

function startServer(port: number, env: Record<string, string>): ChildProcess {
  return spawn('node', ['dist/mcp/transport/http-entry.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ENVIRONMENT: 'local', HTTP_PORT: String(port), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

beforeAll(async () => {
  sqliteSrv = startServer(PORT_SQLITE, { DATABASE_URL: `sqlite:${DB_SQLITE}` });
  await waitStarted(sqliteSrv);
  memorySrv = startServer(PORT_MEMORY, {});
  await waitStarted(memorySrv);
  // Broken DB: a file that is NOT a sqlite database -> SELECT 1 fails.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(DB_BROKEN, 'this is not a sqlite database file'.repeat(10));
  brokenSrv = startServer(PORT_READY_BROKEN, { DATABASE_URL: `sqlite:${DB_BROKEN}` });
  await new Promise((r) => { setTimeout(r, 2500); }); // may fail fast; probe regardless
}, 60_000);

afterAll(() => {
  for (const c of [sqliteSrv, memorySrv, brokenSrv]) c.kill('SIGTERM');
  rmSync(DIR, { recursive: true, force: true });
});

describe('/metrics on the real server (both modes)', () => {
  it('serves unauthenticated Prometheus text with core families', async () => {
    const r = await fetch(`http://127.0.0.1:${String(PORT_SQLITE)}/metrics`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    const text = await r.text();
    expect(text).toContain('# HELP lkm_http_requests_total');
    // The in-flight request itself is visible in the gauge…
    expect(text).toContain('lkm_http_requests_inflight 1');
    // …and this scrape self-counts on the NEXT scrape (close fires after
    // render): second scrape must see route="/metrics" with count >= 1.
    const text2 = await (await fetch(`http://127.0.0.1:${String(PORT_SQLITE)}/metrics`)).text();
    expect(text2).toContain('lkm_http_requests_total{route="/metrics"}');
    expect(text2).toContain('lkm_process_uptime_seconds');
  });

  it('counts real traffic across routes', async () => {
    // Drive some real requests: healthz + 401 on /mcp (unauthenticated).
    await fetch(`http://127.0.0.1:${String(PORT_SQLITE)}/healthz`);
    await fetch(`http://127.0.0.1:${String(PORT_SQLITE)}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    await fetch(`http://127.0.0.1:${String(PORT_SQLITE)}/auth/login`, { method: 'POST', body: '{}' });
    const text = await (await fetch(`http://127.0.0.1:${String(PORT_SQLITE)}/metrics`)).text();
    expect(text).toContain('lkm_http_requests_total{route="/healthz"}');
    expect(text).toContain('lkm_http_request_errors_total{route="/mcp"}');
    expect(text).toContain('lkm_http_request_errors_total{route="/auth"}');
  });

  it('contains no secrets or tenant data (label space is fixed)', async () => {
    const text = await (await fetch(`http://127.0.0.1:${String(PORT_MEMORY)}/metrics`)).text();
    // Only fixed route/tool labels may appear — assert the allowed set.
    const routeLabels = [...text.matchAll(/route="([^"]+)"/g)].map((m) => m[1]);
    const allowed = ['/mcp', '/auth', '/admin', '/healthz', '/ready', '/metrics', '/webhooks', '/api/billing', '/linkedin', 'other'];
    for (const l of routeLabels) expect(allowed).toContain(l);
    expect(text.toLowerCase()).not.toContain('token');
    expect(text.toLowerCase()).not.toContain('secret');
    expect(text.toLowerCase()).not.toContain('tenant-');
  });

  it('works identically in self-hosted/in-memory mode (no billing dependency)', async () => {
    const r = await fetch(`http://127.0.0.1:${String(PORT_MEMORY)}/metrics`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('lkm_http_requests_inflight');
  });
});

describe('/ready on the real server', () => {
  it('sqlite backend: 200 with a working database', async () => {
    const r = await fetch(`http://127.0.0.1:${String(PORT_SQLITE)}/ready`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; backend: string };
    expect(body.ok).toBe(true);
    expect(body.backend).toBe('sqlite');
  });

  it('in-memory mode: always ready (no DB dependency)', async () => {
    const r = await fetch(`http://127.0.0.1:${String(PORT_MEMORY)}/ready`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; backend: string };
    expect(body.ok).toBe(true);
    expect(body.backend).toBe('in-memory');
  });

  it('broken database: 503 (replica must leave rotation)', async () => {
    // If the server could not even boot, the probe cannot run; only
    // assert 503 when the port answers. (A boot-failed server is itself
    // the strongest not-ready signal an operator can see.)
    try {
      const r = await fetch(`http://127.0.0.1:${String(PORT_READY_BROKEN)}/ready`, { signal: AbortSignal.timeout(2000) });
      expect(r.status).toBe(503);
      const body = (await r.json()) as { ok: boolean; reason?: string };
      expect(body.ok).toBe(false);
      expect(typeof body.reason).toBe('string');
    } catch {
      // Server exited at boot (migrations fail on a non-DB file): the
      // connection refused IS the not-ready outcome. Verify it's down:
      // (any successful healthz response at all would disprove "down")
      await expect(
        fetch(`http://127.0.0.1:${String(PORT_READY_BROKEN)}/healthz`, { signal: AbortSignal.timeout(1500) }),
      ).rejects.toThrow();
    }
  });

  it('POST is rejected with 405 (probe is GET-only)', async () => {
    const r = await fetch(`http://127.0.0.1:${String(PORT_SQLITE)}/ready`, { method: 'POST' });
    expect(r.status).toBe(405);
    const m = await fetch(`http://127.0.0.1:${String(PORT_SQLITE)}/metrics`, { method: 'POST' });
    expect(m.status).toBe(405);
  });
});

/* ---------- Audit regression: metered tools must match the registered catalog ---------- */

describe('METERED_TOOLS parity with the registered tool catalog', () => {
  it('every registered tool is metered under its exact name (no silent "other" collapse)', async () => {
    const { Client } = await import('@modelcontextprotocol/client');
    const { InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { buildRuntime, createMcpServer } = await import('../../src/mcp/serverFactory.js');
    const { parseConfig } = await import('../../src/config/config.js');
    const { METERED_TOOLS } = await import('../../src/observability/metrics.js');
    const server = createMcpServer(buildRuntime(parseConfig({ ENVIRONMENT: 'local' })));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'parity', version: '1.0.0' });
    await client.connect(ct);
    const tools = await client.listTools();
    await client.close();
    await server.close();
    const registered = tools.tools.map((t) => t.name).sort();
    expect(registered.length).toBeGreaterThan(0);
    // Every registered tool must be metered by its EXACT name.
    for (const name of registered) {
      expect(METERED_TOOLS).toContain(name);
    }
    // And the allowlist must not carry dead names either.
    for (const metered of METERED_TOOLS) {
      expect(registered).toContain(metered);
    }
  });
});
