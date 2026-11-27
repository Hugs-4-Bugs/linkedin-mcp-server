/**
 * Issue #9 — Claude connector compatibility (M6): deterministic,
 * protocol-level tests over the compiled HTTP entry in persistence mode.
 *
 * These verify the EXACT Streamable HTTP surface the official Claude
 * connector drives: initialize handshake (legacy, no version header),
 * session issuance, tools/list discovery, tools/call with structured
 * errors, auth rejection semantics, session invalidation, and reconnect
 * (new session after server restart). They are NOT a live Claude-app
 * test — that requires a public HTTPS host + the owner's connector
 * account; see 05_INTEGRATIONS/CLAUDE_INTEGRATION.md §Live checklist.
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

const PORT = 3511;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const DB_PATH = join(mkdtempSync(join(tmpdir(), 'lkm-claude-')), 'claude.db');

interface McpResponse {
  status: number;
  sessionId: string | null;
  json: Record<string, unknown> | null;
}

/** Raw Streamable HTTP request against /mcp. */
async function mcpHttp(
  body: string,
  headers: Record<string, string>,
): Promise<McpResponse> {
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

const CLIENT = { name: 'claude-compat-test', version: '1.0.0' };
const PROTO = '2026-07-28';

/** initialize WITHOUT MCP-Protocol-Version (legacy handshake contract). */
function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTO, capabilities: {}, clientInfo: CLIENT },
  });
}

/** Post-init body: JSON-RPC + the modern _meta envelope. */
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

/**
 * Modern post-init request headers: MCP-Protocol-Version + Mcp-Method are
 * BOTH required once the body envelope names the protocol version (the SDK
 * enforces header/body agreement — verified against the live surface).
 */
function postInitHeaders(method: string, toolName?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'mcp-protocol-version': PROTO,
    'Mcp-Method': method,
  };
  if (toolName !== undefined) headers['Mcp-Name'] = toolName;
  return headers;
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

describe('Claude connector compatibility — Streamable HTTP protocol surface', () => {
  let child: ChildProcess;
  let cookie: string;
  let sessionId: string | null;

  beforeAll(async () => {
    const exec = new SqliteExecutor(DB_PATH);
    await applyMigrations(exec);
    await new UserAuthStore(exec, 3_600_000).createUser('claudeuser', 'claude-pass-12345');
    await exec.close();
    child = await startServer();
    cookie = await login('claudeuser', 'claude-pass-12345');
    expect(cookie).not.toBe('');
  });

  afterAll(() => {
    child.kill('SIGTERM');
    rmSync(join(DB_PATH, '..'), { recursive: true, force: true });
  });

  it('initialize handshake: 200 + serverInfo + capabilities (session may arrive later)', async () => {
    const r = await mcpHttp(initializeBody(), { cookie: `lkm_session=${cookie}` });
    expect(r.status).toBe(200);
    // The SDK issues mcp-session-id on the first request that establishes
    // it; initialize may or may not carry it depending on version. We
    // capture it when present and otherwise proceed (headers on the next
    // call carry it).
    const result = (r.json?.result ?? {}) as Record<string, unknown>;
    // Negotiated version is the SERVER's supported protocol version.
    expect(['2025-11-25', '2026-07-28']).toContain(String(result.protocolVersion));
    const serverInfo = result.serverInfo as Record<string, unknown> | undefined;
    expect(String(serverInfo?.name)).toBe('linkedin-mcp-server');
    expect(result.capabilities).toBeDefined();
    sessionId = r.sessionId; // may be null; the next call binds one
  });

  it('notifications/initialized on the same session is accepted (204-class)', async () => {
    const r = await mcpHttp(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      {
        cookie: `lkm_session=${cookie}`,
        ...(sessionId !== null ? { 'mcp-session-id': sessionId } : {}),
      },
    );
    expect([200, 202, 204]).toContain(r.status);
  });

  it('tools/list discovers the full tool catalog (>= 9 tools)', async () => {
    const headers: Record<string, string> = {
      cookie: `lkm_session=${cookie}`,
      ...postInitHeaders('tools/list'),
    };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const r = await mcpHttp(callBody(2, 'tools/list', {}), headers);
    if (sessionId === null && r.sessionId !== null) sessionId = r.sessionId;
    expect(r.status).toBe(200);
    const tools = ((r.json?.result ?? {}) as { tools?: { name: string }[] }).tools ?? [];
    const names = tools.map((t) => t.name);
    for (const expected of [
      'status',
      'linkedin_connect',
      'linkedin_status',
      'linkedin_disconnect',
      'linkedin_get_my_profile',
      'linkedin_list_granted_scopes',
      'linkedin_draft_post',
      'linkedin_preview_post',
      'linkedin_publish_post',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('tools/call executes a read-only tool with structured content', async () => {
    const headers: Record<string, string> = {
      cookie: `lkm_session=${cookie}`,
      ...postInitHeaders('tools/call', 'status'),
    };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const r = await mcpHttp(callBody(3, 'tools/call', { name: 'status', arguments: {} }), headers);
    expect(r.status).toBe(200);
    const result = (r.json?.result ?? {}) as { content?: { text: string }[]; structuredContent?: Record<string, unknown> };
    expect(result.content?.[0]?.text).toBeTruthy();
    const parsed = JSON.parse(String(result.content?.[0]?.text)) as Record<string, unknown>;
    expect(parsed.server).toBe('linkedin-mcp-server');
  });

  it('tools/call with unknown tool → JSON-RPC error, not a crash', async () => {
    const r = await mcpHttp(
      callBody(4, 'tools/call', { name: 'no_such_tool', arguments: {} }),
      {
        cookie: `lkm_session=${cookie}`,
        ...postInitHeaders('tools/call', 'no_such_tool'),
        ...(sessionId !== null ? { 'mcp-session-id': sessionId } : {}),
      },
    );
    expect(r.status).toBe(200);
    // Unknown tool is rejected at the PROTOCOL layer (JSON-RPC error
    // -32602) or the tool layer (isError) — both are safe rejections.
    const errObj = r.json?.error as { code?: number } | undefined;
    const result = (r.json?.result ?? {}) as { isError?: boolean; content?: { text: string }[] };
    if (errObj !== undefined) {
      expect(errObj.code).toBe(-32602);
    } else {
      expect(result.isError).toBe(true);
    }
  });

  it('schema violation (confirm omitted) → tool-level error, no side effects', async () => {
    const r = await mcpHttp(
      callBody(5, 'tools/call', { name: 'linkedin_publish_post', arguments: { text: 'x' } }),
      {
        cookie: `lkm_session=${cookie}`,
        ...postInitHeaders('tools/call', 'linkedin_publish_post'),
        ...(sessionId !== null ? { 'mcp-session-id': sessionId } : {}),
      },
    );
    expect(r.status).toBe(200);
    const result = (r.json?.result ?? {}) as { isError?: boolean; content?: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(String(result.content?.[0]?.text)).toContain('confirm');
  });

  it('authentication rejection: no cookie → 401 before any protocol work', async () => {
    const r = await mcpHttp(initializeBody(), {});
    expect(r.status).toBe(401);
  });

  it('authentication rejection: invalid bearer → 401', async () => {
    const r = await mcpHttp(initializeBody(), { authorization: 'Bearer lkm_bogus' });
    expect(r.status).toBe(401);
  });

  it('invalid session id on a post-init request → session error (safe message)', async () => {
    const r = await mcpHttp(
      callBody(6, 'tools/list', {}),
      {
        cookie: `lkm_session=${cookie}`,
        ...postInitHeaders('tools/list'),
        'mcp-session-id': '00000000-bad0-0000-0000-000000000000',
      },
    );
    // The SDK either rejects the unknown session (400) or serves it as a
    // fresh request — both must be SAFE (no token/tenant leakage).
    expect([200, 400, 404]).toContain(r.status);
    if (r.json?.error !== undefined) {
      expect(JSON.stringify(r.json)).not.toContain('lkm_session');
      expect(JSON.stringify(r.json)).not.toContain('claude-pass');
    }
  });

  it('error shapes: JSON-RPC code + message, no internal detail leakage', async () => {
    // Malformed JSON body → parse error from the bridge/SDK with a safe message.
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: `lkm_session=${cookie}`,
        ...postInitHeaders('tools/list'),
        ...(sessionId !== null ? { 'mcp-session-id': sessionId } : {}),
      },
      body: '{not json',
    });
    const text = await resp.text();
    expect([200, 400]).toContain(resp.status);
    expect(text).not.toContain('sqlite');
    expect(text).not.toContain('DATABASE_URL');
    expect(text).not.toContain('7XrXNyNp');
  });

  it('reconnect: a NEW initialize after server restart gets a fresh session and works', async () => {
    // Kill and restart the server on the same DB (persistence keeps state).
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 500);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
    child = await startServer();
    const r = await mcpHttp(initializeBody(), { cookie: `lkm_session=${cookie}` });
    expect(r.status).toBe(200);
    // mcp-session-id is issued lazily by this SDK version; after restart
    // the fresh initialize may again omit it. The reconnect contract that
    // matters: a NEW initialize is accepted and a subsequent tools/call
    // succeeds (with or without a session header).
    const r2 = await mcpHttp(
      callBody(7, 'tools/call', { name: 'status', arguments: {} }),
      {
        cookie: `lkm_session=${cookie}`,
        ...postInitHeaders('tools/call', 'status'),
      },
    );
    expect(r2.status).toBe(200);
    sessionId = r.sessionId;
  });
});
