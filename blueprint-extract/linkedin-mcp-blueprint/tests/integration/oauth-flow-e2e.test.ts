/**
 * M2 integration: the complete mock 3LO OAuth flow against the compiled
 * HTTP entry (loopback), exactly as a browser + agent would drive it:
 *
 *   1. GET /linkedin/connect        → 303 to LinkedIn-shaped authorize URL
 *   2. GET /mock/linkedin/authorize → 303 back to callback with code+state
 *   3. GET /linkedin/callback       → 200, tokens sealed in vault
 *   4. MCP tools/call linkedin_status → connected:true
 *   5. MCP tools/call linkedin_disconnect {confirm:true} → tokens wiped
 *   6. status then disconnected
 *
 * Also covers: state validation failure paths and MCP tool confirmation gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const PORT = 3351;
const BASE = `http://127.0.0.1:${String(PORT)}`;

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

async function mcpCall(id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: modernBody(id, 'tools/call', { name, arguments: args }),
  });
  expect(resp.status).toBe(200);
  const json = (await resp.json()) as { result?: { content?: { type: string; text: string }[] } };
  const text = json.result?.content?.[0]?.text;
  return text !== undefined ? (JSON.parse(text) as Record<string, unknown>) : {};
}

describe('full mock 3LO flow over the compiled HTTP entry', () => {
  let child: ChildProcess;

  beforeAll(async () => {
    child = spawn('node', ['dist/mcp/transport/http-entry.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ENVIRONMENT: 'local',
        OAUTH_PROVIDER: 'mock',
        HTTP_PORT: String(PORT),
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
  });

  afterAll(() => {
    child.kill('SIGTERM');
  });

  it('walks connect → mock consent → callback → connected status', async () => {
    // 1. start the flow (as the browser would)
    const connectResp = await fetch(`${BASE}/linkedin/connect`, { redirect: 'manual' });
    expect(connectResp.status).toBe(303);
    const authorizeUrl = connectResp.headers.get('location') ?? '';
    expect(authorizeUrl.startsWith('https://www.linkedin.com/oauth/v2/authorization')).toBe(true);
    const state = new URL(authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    // 2. simulate the mock consent screen (approves + redirects to callback)
    const mockResp = await fetch(
      `${BASE}/mock/linkedin/authorize?state=${state ?? ''}&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${String(PORT)}/linkedin/callback`)}`,
      { redirect: 'manual' },
    );
    expect(mockResp.status).toBe(303);
    const callbackUrl = mockResp.headers.get('location') ?? '';
    expect(callbackUrl.startsWith(`http://127.0.0.1:${String(PORT)}/linkedin/callback?`)).toBe(true);

    // 3. drive the callback
    const cbResp = await fetch(callbackUrl);
    expect(cbResp.status).toBe(200);
    const cbJson = (await cbResp.json()) as { connected: boolean; scopes: string[] };
    expect(cbJson.connected).toBe(true);
    expect(cbJson.scopes).toContain('w_member_social');

    // 4. the MCP tool sees the connection
    const status = await mcpCall(10, 'linkedin_status', {});
    expect(status.connected).toBe(true);
    expect(status.scopes).toContain('w_member_social');
  });

  it('the server status tool reflects connected state + mock provider', async () => {
    const status = await mcpCall(11, 'status', {});
    expect(status.linkedin).toBe('connected');
    expect(status.oauthProvider).toBe('mock');
  });

  it('disconnect requires confirm=true; with it, tokens are wiped', async () => {
    // without confirmation the schema rejects (text content is not JSON)
    const respRaw = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'linkedin_disconnect',
      },
      body: modernBody(12, 'tools/call', { name: 'linkedin_disconnect', arguments: {} }),
    });
    const raw = (await respRaw.json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(raw.result?.isError).toBe(true);
    expect(raw.result?.content?.[0]?.text).toContain('confirm');

    // with confirmation: disconnect succeeds
    const done = await mcpCall(14, 'linkedin_disconnect', { confirm: true });
    expect(done.disconnected).toBe(true);
    expect(done.hadTokens).toBe(true);

    const status = await mcpCall(15, 'linkedin_status', {});
    expect(status.connected).toBe(false);
  });

  it('callback with a forged state returns 400 and stores nothing', async () => {
    const pre = await mcpCall(16, 'linkedin_status', {});
    expect(pre.connected).toBe(false); // prior test disconnected; isolation guard
    const resp = await fetch(`${BASE}/linkedin/callback?state=forged&code=whatever`);
    expect(resp.status).toBe(400);
    const status = await mcpCall(17, 'linkedin_status', {});
    expect(status.connected).toBe(false);
  });

  it('callback replaying a consumed state returns 400 (single-use)', async () => {
    const connectResp = await fetch(`${BASE}/linkedin/connect`, { redirect: 'manual' });
    const authorizeUrl = connectResp.headers.get('location') ?? '';
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const mockResp = await fetch(
      `${BASE}/mock/linkedin/authorize?state=${state}&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${String(PORT)}/linkedin/callback`)}`,
      { redirect: 'manual' },
    );
    const callbackUrl = mockResp.headers.get('location') ?? '';
    const first = await fetch(callbackUrl);
    expect(first.status).toBe(200);
    const replay = await fetch(callbackUrl);
    expect(replay.status).toBe(400);
  });

  it('connect route enforces the rate limit (429 after 6 starts)', async () => {
    // The prior tests consumed some budget; loop until 429 shows up.
    let saw429 = false;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${BASE}/linkedin/connect`, { redirect: 'manual' });
      if (r.status === 429) {
        saw429 = true;
        break;
      }
      expect([303, 429]).toContain(r.status);
    }
    expect(saw429).toBe(true);
  });
});
