/**
 * Protocol-level tests: server factory + in-memory transport (unit) and
 * both production transports via the official client (integration).
 * These codify the manual E2E checks run at M1 into the repeatable suite.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { parseConfig } from '../../src/config/config.js';
import { buildRuntime, createMcpServer } from '../../src/mcp/serverFactory.js';

const config = parseConfig({ ENVIRONMENT: 'local' });

async function withClient(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createMcpServer(buildRuntime(config));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('tool catalog (in-memory transport)', () => {
  it('exposes the M2 catalog: status + connection lifecycle tools', async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual([
        'status',
        'linkedin_connect',
        'linkedin_status',
        'linkedin_disconnect',
        'linkedin_get_my_profile',
        'linkedin_list_granted_scopes',
      ]);
      for (const t of tools.tools) {
        expect(t.description?.length ?? 0).toBeGreaterThan(10);
      }
    });
  });

  it('status returns structured server identity with mock provider', async () => {
    await withClient(async (client) => {
      const res = await client.callTool({ name: 'status', arguments: {} });
      expect(res.isError).toBeFalsy();
      const text = res.content[0];
      expect(text?.type).toBe('text');
      const parsed = JSON.parse((text as { type: 'text'; text: string }).text) as Record<
        string,
        string
      >;
      expect(parsed.server).toBe('linkedin-mcp-server');
      expect(parsed.environment).toBe('local');
      expect(parsed.oauthProvider).toBe('mock');
      expect(parsed.linkedin).toBe('not-connected');
    });
  });

  it('linkedin_status reports disconnected before any flow', async () => {
    await withClient(async (client) => {
      const res = await client.callTool({ name: 'linkedin_status', arguments: {} });
      expect(res.isError).toBeFalsy();
      const text = res.content[0] as { type: 'text'; text: string };
      const parsed = JSON.parse(text.text) as Record<string, unknown>;
      expect(parsed.connected).toBe(false);
      expect(parsed.expiresAt).toBeNull();
    });
  });

  it('linkedin_disconnect without confirm=true is rejected by schema', async () => {
    await withClient(async (client) => {
      const res = await client.callTool({ name: 'linkedin_disconnect', arguments: {} });
      expect(res.isError).toBe(true);
    });
  });

  it('unknown tool is rejected as invalid params', async () => {
    await withClient(async (client) => {
      await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toMatchObject({
        code: -32602,
      });
    });
  });

  it('schema violation surfaces as tool error content, not a crash', async () => {
    await withClient(async (client) => {
      // status schema is strict: extra args are invalid
      const res = await client.callTool({ name: 'status', arguments: { junk: 1 } });
      expect(res.isError).toBe(true);
    });
  });
});
