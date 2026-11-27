/**
 * Issue #10 — ChatGPT MCP connector compatibility (M6): deterministic,
 * protocol-level tests over the compiled HTTP entry in persistence mode.
 *
 * ChatGPT's MCP support drives the same Streamable HTTP surface (remote
 * server URL configured in the developer/connector settings). This suite
 * asserts that surface from the ChatGPT connector's perspective — including
 * behaviors specific to how ChatGPT connects: URL-based configuration
 * (no local command), cookie-session auth carried per request, and tool
 * invocation with structured results the ChatGPT tools surface consumes.
 *
 * NOT a live ChatGPT-app test: that requires a public HTTPS host + a
 * plan that has connector support; see 05_INTEGRATIONS/CHATGPT_INTEGRATION.md
 * §Live checklist for the owner-side validation procedure.
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

const PORT = 3521;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'lkm-chatgpt-')), 'chatgpt.db');
const PROTO = '2026-07-28';
const CLIENT = { name: 'chatgpt-compat-test', version: '1.0.0' };

async function mcpHttp(
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; sessionId: string | null; json: Record<string, unknown> | null }> {
  const resp = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  });
  const sessionId = resp.headers.get('mcp-session-id');
  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  if (text.trim().startsWith('{')) {
    json = JSON.parse(text) as Record<string, unknown>;
  } else if (text.includes('data:')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (line !== undefined) json = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
  }
  return { status: resp.status, sessionId, json };
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTO, capabilities: {}, clientInfo: CLIENT },
  });
}

function postInitHeaders(method: string, toolName?: string): Record<string, string> {
  const h: Record<string, string> = {
    'mcp-protocol-version': PROTO,
    'Mcp-Method': method,
  };
  if (toolName !== undefined) h['Mcp-Name'] = toolName;
  return h;
}

function callBody(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTO,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': CLIENT,
      },
    },
  });
}

async function startServer(): Promise<ChildProcess> {
  const child = spawn('node', ['dist/mcp/transport/http-entry.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ENVIRONMENT: 'local',
      OAUTH_PROVIDER: 'mock',
      HTTP_PORT: String(PORT),
      DATABASE_URL: `sqlite:${DB_PATH}`,
      TOKEN_VAULT_KEY: '7XrXNyNpMoOKYhhm11whIqdcbahq+Ruky/wym2tYp6k=',
      LINKEDIN_REDIRECT_URI: `${BASE}/linkedin/callback`,
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
    setTimeout(resolve, 3000);
  });
  return child;
}

async function login(u: string, p: string): Promise<string> {
  const resp = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const setCookie = resp.headers.get('set-cookie') ?? '';
  return /lkm_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
}

describe('ChatGPT MCP connector compatibility — Streamable HTTP protocol surface', () => {
  let child: ChildProcess;
  let cookie: string;
  let sessionId: string | null;

  beforeAll(async () => {
    const exec = new SqliteExecutor(DB_PATH);
    await applyMigrations(exec);
    await new UserAuthStore(exec, 3_600_000).createUser('gptuser', 'gpt-pass-12345');
    await exec.close();
    child = await startServer();
    cookie = await login('gptuser', 'gpt-pass-12345');
    expect(cookie).not.toBe('');
  });

  afterAll(() => {
    child.kill('SIGTERM');
    rmSync(join(DB_PATH, '..'), { recursive: true, force: true });
  });

  it('initialize handshake succeeds with server identity + tool capability', async () => {
    const r = await mcpHttp(initializeBody(), { cookie: `lkm_session=${cookie}` });
    expect(r.status).toBe(200);
    const result = (r.json?.result ?? {}) as Record<string, unknown>;
    expect(['2025-11-25', '2026-07-28']).toContain(String(result.protocolVersion));
    const serverInfo = result.serverInfo as Record<string, unknown> | undefined;
    expect(String(serverInfo?.name)).toBe('linkedin-mcp-server');
    const caps = result.capabilities as Record<string, unknown> | undefined;
    expect(caps?.tools).toBeDefined();
    sessionId = r.sessionId;
  });

  it('tool discovery returns the catalog with descriptions + strict schemas', async () => {
    const headers: Record<string, string> = {
      cookie: `lkm_session=${cookie}`,
      ...postInitHeaders('tools/list'),
    };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const r = await mcpHttp(callBody(2, 'tools/list', {}), headers);
    if (sessionId === null && r.sessionId !== null) sessionId = r.sessionId;
    expect(r.status).toBe(200);
    const tools = ((r.json?.result ?? {}) as { tools?: Record<string, unknown>[] }).tools ?? [];
    expect(tools.length).toBeGreaterThanOrEqual(9);
    for (const t of tools) {
      expect(String(t.name)).toBeTruthy();
      expect(String(t.description)).toBeTruthy();
      expect(t.inputSchema).toBeDefined(); // ChatGPT renders schemas for args
    }
  });

  it('tool invocation returns structured content a client can render', async () => {
    const headers: Record<string, string> = {
      cookie: `lkm_session=${cookie}`,
      ...postInitHeaders('tools/call', 'status'),
    };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const r = await mcpHttp(callBody(3, 'tools/call', { name: 'status', arguments: {} }), headers);
    expect(r.status).toBe(200);
    const result = (r.json?.result ?? {}) as { content?: { text: string }[]; structuredContent?: unknown };
    const parsed = JSON.parse(String(result.content?.[0]?.text)) as Record<string, unknown>;
    expect(parsed.server).toBe('linkedin-mcp-server');
    expect(result.structuredContent).toBeDefined();
  });

  it('read tools work while LinkedIn is disconnected (honest state, no fake data)', async () => {
    const headers: Record<string, string> = {
      cookie: `lkm_session=${cookie}`,
      ...postInitHeaders('tools/call', 'linkedin_status'),
    };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const r = await mcpHttp(callBody(4, 'tools/call', { name: 'linkedin_status', arguments: {} }), headers);
    expect(r.status).toBe(200);
    const result = (r.json?.result ?? {}) as { content?: { text: string }[] };
    const parsed = JSON.parse(String(result.content?.[0]?.text)) as Record<string, unknown>;
    expect(parsed.connected).toBe(false); // honest: no LinkedIn connected yet
  });

  it('write tools require confirmation — ChatGPT cannot bypass it either', async () => {
    const headers: Record<string, string> = {
      cookie: `lkm_session=${cookie}`,
      ...postInitHeaders('tools/call', 'linkedin_publish_post'),
    };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const r = await mcpHttp(
      callBody(5, 'tools/call', { name: 'linkedin_publish_post', arguments: { text: 'hello' } }),
      headers,
    );
    expect(r.status).toBe(200);
    const result = (r.json?.result ?? {}) as { isError?: boolean; content?: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(String(result.content?.[0]?.text)).toContain('confirm');
  });

  it('authentication rejection: no credentials → 401 before protocol handling', async () => {
    const r = await mcpHttp(initializeBody(), {});
    expect(r.status).toBe(401);
  });

  it('session invalidation: an unknown session id yields a safe protocol error', async () => {
    const r = await mcpHttp(callBody(6, 'tools/list', {}), {
      cookie: `lkm_session=${cookie}`,
      ...postInitHeaders('tools/list'),
      'mcp-session-id': 'deadbeef-0000-0000-0000-000000000000',
    });
    expect([200, 400, 404]).toContain(r.status);
    expect(JSON.stringify(r.json ?? {})).not.toContain('gpt-pass');
    expect(JSON.stringify(r.json ?? {})).not.toContain('lkm_session');
  });

  it('error handling: transport-level errors never leak internals', async () => {
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: `lkm_session=${cookie}`,
        ...postInitHeaders('tools/list'),
      },
      body: '{"broken',
    });
    expect([200, 400]).toContain(resp.status);
    const text = await resp.text();
    expect(text).not.toContain('sqlite');
    expect(text).not.toContain('DATABASE_URL');
    expect(text).not.toContain('7XrXNyNp');
  });

  it('logout invalidates the session for MCP too (credential lifecycle)', async () => {
    // ONE login: its cookie + its CSRF token (the digest pair lives on
    // that session row — a csrf from a different session is correctly 403).
    const loginResp = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'gptuser', password: 'gpt-pass-12345' }),
    });
    const setCookie = loginResp.headers.get('set-cookie') ?? '';
    const cookie2 = /lkm_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
    const loginJson = (await loginResp.json()) as { csrfToken?: string };
    const csrf = loginJson.csrfToken ?? '';
    expect(cookie2).not.toBe('');
    const out = await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { cookie: `lkm_session=${cookie2}`, 'x-csrf-token': csrf },
    });
    expect(out.status).toBe(200);
    // MCP on the revoked session → 401 (auth middleware rejects)
    const r = await mcpHttp(initializeBody(), { cookie: `lkm_session=${cookie2}` });
    expect(r.status).toBe(401);
  });

  it('reconnect after server restart: fresh handshake + call succeed (same DB)', async () => {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 500);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
    child = await startServer();
    const r = await mcpHttp(initializeBody(), { cookie: `lkm_session=${cookie}` });
    expect(r.status).toBe(200);
    const r2 = await mcpHttp(callBody(7, 'tools/call', { name: 'status', arguments: {} }), {
      cookie: `lkm_session=${cookie}`,
      ...postInitHeaders('tools/call', 'status'),
    });
    expect(r2.status).toBe(200);
  });
});
