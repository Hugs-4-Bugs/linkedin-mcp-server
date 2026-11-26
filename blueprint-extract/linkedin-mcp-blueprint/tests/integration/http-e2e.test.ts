/**
 * Integration: drives the compiled HTTP entry over real loopback HTTP using
 * the modern 2026-07-28 envelope (Mcp-Method / Mcp-Name headers), plus
 * negative cases (404 route, legacy no-accept 406, header/body mismatch).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const PORT = 3321;
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

describe('HTTP transport E2E (loopback)', () => {
  let child: ChildProcess;

  beforeAll(async () => {
    child = spawn('node', ['dist/mcp/transport/http-entry.js'], {
      cwd: process.cwd(),
      env: { ...process.env, ENVIRONMENT: 'local', HTTP_PORT: String(PORT) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await once(child, 'spawn');
    // wait for the startup log line on stderr
    await new Promise<void>((resolve) => {
      const onData = (d: Buffer): void => {
        if (String(d).includes('http MCP server started')) {
          child.stderr?.off('data', onData);
          resolve();
        }
      };
      child.stderr?.on('data', onData);
      setTimeout(resolve, 4000);
    });
  });

  afterAll(() => {
    child.kill('SIGTERM');
  });

  it('serves tools/list via the modern envelope', async () => {
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: modernBody(1, 'tools/list', {}),
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { result?: { tools?: { name: string }[] } };
    expect(json.result?.tools?.map((t) => t.name)).toEqual([
      'status',
      'linkedin_connect',
      'linkedin_status',
      'linkedin_disconnect',
      'linkedin_get_my_profile',
      'linkedin_list_granted_scopes',
    ]);
  });

  it('calls status and returns structured identity', async () => {
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'status',
      },
      body: modernBody(2, 'tools/call', { name: 'status', arguments: {} }),
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as {
      result?: { content?: { type: string; text: string }[] };
    };
    const text = json.result?.content?.[0];
    expect(text?.type).toBe('text');
    const parsed = JSON.parse(text?.text ?? '{}') as Record<string, string>;
    expect(parsed.server).toBe('linkedin-mcp-server');
    expect(parsed.environment).toBe('local');
  });

  it('404s non-MCP routes', async () => {
    const resp = await fetch(`${BASE}/`);
    expect(resp.status).toBe(404);
  });

  it('406s a legacy request whose Accept header excludes JSON and SSE', async () => {
    // Legacy-era request + non-MCP accept → 406 (modern-era requests carry
    // their own envelope validation which fires first).
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/html' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(resp.status).toBe(406);
  });

  it('400s when Mcp-Method header is missing on modern requests', async () => {
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
      },
      body: modernBody(4, 'tools/list', {}),
    });
    expect(resp.status).toBe(400);
    const json = (await resp.json()) as { error?: { code: number } };
    expect(json.error?.code).toBe(-32020);
  });

  it('400s when Mcp-Name header disagrees with the tool in the body', async () => {
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'wrong-tool',
      },
      body: modernBody(5, 'tools/call', { name: 'status', arguments: {} }),
    });
    expect(resp.status).toBe(400);
  });
});
