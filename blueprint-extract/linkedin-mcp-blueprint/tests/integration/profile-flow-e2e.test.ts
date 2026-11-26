/**
 * M3 integration: the full mock 3LO + profile flow over the compiled HTTP
 * entry. Drives the real process: connect → mock consent → callback →
 * get_my_profile returns the fixture identity through the MCP protocol.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const PORT = 3361;
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
  const json = (await resp.json()) as { result?: { content?: { type: string; text: string }[]; isError?: boolean } };
  const text = json.result?.content?.[0]?.text;
  return text !== undefined ? (JSON.parse(text) as Record<string, unknown>) : {};
}

describe('profile + scope tools over the compiled HTTP entry (mock 3LO)', () => {
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

  it('get_my_profile before connection → structured not-connected error', async () => {
    const body = await mcpCall(20, 'linkedin_get_my_profile', {});
    expect(body.code).toBe('not-connected');
  });

  it('full flow: connect → consent → callback → profile serves the mock identity', async () => {
    const connectResp = await fetch(`${BASE}/linkedin/connect`, { redirect: 'manual' });
    expect(connectResp.status).toBe(303);
    const authorizeUrl = connectResp.headers.get('location') ?? '';
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    const mockResp = await fetch(
      `${BASE}/mock/linkedin/authorize?state=${state}&redirect_uri=${encodeURIComponent(`${BASE}/linkedin/callback`)}`,
      { redirect: 'manual' },
    );
    expect(mockResp.status).toBe(303);
    const callbackUrl = mockResp.headers.get('location') ?? '';
    const cb = await fetch(callbackUrl);
    expect(cb.status).toBe(200);

    const profile = await mcpCall(21, 'linkedin_get_my_profile', {});
    expect(profile.memberId).toBeDefined();
    expect(String(profile.name)).toContain('Mock Member');
    expect(String(profile.email)).toContain('@example.invalid');
    // permitted fields only
    expect(profile.headline).toBeUndefined();
  });

  it('scope tool reports the honest claim state after connect', async () => {
    const body = await mcpCall(22, 'linkedin_list_granted_scopes', {});
    expect(body.verification).toBe('token-response');
    expect(body.unverified).toBe(false);
    expect(body.connectionState).toBe('connected');
    expect(String(body.note)).toContain('no introspection');
  });

  it('profile rejects extra identity arguments at the schema boundary', async () => {
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'linkedin_get_my_profile',
      },
      body: modernBody(23, 'tools/call', {
        name: 'linkedin_get_my_profile',
        arguments: { memberId: 'attacker-impersonation' },
      }),
    });
    const json = (await resp.json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(json.result?.isError).toBe(true);
    expect(json.result?.content?.[0]?.text).toContain('Unrecognized key: "memberId"');
  });

  it('disconnect → profile returns to not-connected; scopes to disconnected', async () => {
    const done = await mcpCall(24, 'linkedin_disconnect', { confirm: true });
    expect(done.disconnected).toBe(true);
    const profile = await mcpCall(25, 'linkedin_get_my_profile', {});
    expect(profile.code).toBe('not-connected');
    const scopes = await mcpCall(26, 'linkedin_list_granted_scopes', {});
    expect(scopes.connectionState).toBe('disconnected');
    expect(scopes.unverified).toBe(true);
  });
});
