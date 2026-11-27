/**
 * M4 integration: the full mock 3LO + publishing flow over the compiled
 * HTTP entry. Drives the real process: connect → mock consent → callback →
 * draft → preview → publish (confirm gate) → verify the publication result
 * and duplicate protection through the MCP protocol.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

const PORT = 3362;
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

async function rawCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
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
  return { status: resp.status, json: await resp.json() };
}

async function mcpCall(id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { json } = await rawCall(id, name, args);
  const result = (json as { result?: { content?: { type: string; text: string }[] } }).result;
  const text = result?.content?.[0]?.text;
  return text !== undefined ? (JSON.parse(text) as Record<string, unknown>) : {};
}

describe('publishing flow over the compiled HTTP entry (mock 3LO)', () => {
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

  it('publish before connection → structured not-connected, no submission', async () => {
    const body = await mcpCall(30, 'linkedin_publish_post', { text: 'x', confirm: true });
    expect(body.code).toBe('not-connected');
  });

  it('confirm gate at the protocol boundary: confirm:false → schema rejection', async () => {
    const { json } = await rawCall(31, 'linkedin_publish_post', { text: 'x', confirm: false });
    const result = json as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(result.result?.isError).toBe(true);
    expect(result.result?.content?.[0]?.text).toContain('confirm');
  });

  it('full flow: connect → consent → callback → draft → preview → publish', async () => {
    const connectResp = await fetch(`${BASE}/linkedin/connect`, { redirect: 'manual' });
    expect(connectResp.status).toBe(303);
    const authorizeUrl = connectResp.headers.get('location') ?? '';
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    const mockResp = await fetch(
      `${BASE}/mock/linkedin/authorize?state=${state}&redirect_uri=${encodeURIComponent(`${BASE}/linkedin/callback`)}`,
      { redirect: 'manual' },
    );
    const callbackUrl = mockResp.headers.get('location') ?? '';
    const cb = await fetch(callbackUrl);
    expect(cb.status).toBe(200);

    // draft: local validation + preview, no provider call
    const draft = await mcpCall(32, 'linkedin_draft_post', { text: 'E2E milestone post' });
    expect((draft.draft as Record<string, unknown>).valid).toBe(true);
    expect(draft.preview).toBe('E2E milestone post');

    // preview: exact submission payload with the connected identity
    const preview = await mcpCall(33, 'linkedin_preview_post', { text: 'E2E milestone post' });
    const submission = preview.exactSubmission as Record<string, unknown>;
    expect(String(submission.author)).toMatch(/^urn:li:person:mock-member-/);
    expect(submission.commentary).toBe('E2E milestone post');
    expect(submission.visibility).toBe('PUBLIC');

    // publish with confirmation
    const published = await mcpCall(34, 'linkedin_publish_post', {
      text: 'E2E milestone post',
      confirm: true,
    });
    expect(published.published).toBe(true);
    expect(String(published.postUrn)).toMatch(/^urn:li:share:[0-9]+$/);
    expect(published.confirmedByProvider).toBe(true);

    // duplicate protection through the protocol
    const dup = await mcpCall(35, 'linkedin_publish_post', {
      text: 'E2E milestone post',
      confirm: true,
    });
    expect(dup.code).toBe('duplicate-recent-identical');

    // a second, different post publishes fine (window is content-bound)
    const second = await mcpCall(36, 'linkedin_publish_post', {
      text: 'E2E milestone post (second)',
      confirm: true,
    });
    expect(second.published).toBe(true);
  });

  it('publish never accepts a caller-supplied author (schema boundary)', async () => {
    const { json } = await rawCall(37, 'linkedin_publish_post', {
      text: 'x',
      confirm: true,
      author: 'urn:li:person:attacker',
    });
    const result = json as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(result.result?.isError).toBe(true);
    expect(result.result?.content?.[0]?.text).toContain('Unrecognized key: "author"');
  });

  it('invalid content is refused before submission (3000-char limit)', async () => {
    const body = await mcpCall(38, 'linkedin_publish_post', {
      text: 'y'.repeat(4000), // passes the schema cap, fails tool validation
      confirm: true,
    });
    expect(body.code).toBe('invalid-content-too-long');
  });

  it('disconnect → publish returns to not-connected', async () => {
    await mcpCall(39, 'linkedin_disconnect', { confirm: true });
    const body = await mcpCall(40, 'linkedin_publish_post', { text: 'x', confirm: true });
    expect(body.code).toBe('not-connected');
  });
});
