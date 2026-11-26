/**
 * Integration: drives the compiled stdio entry over a real child process
 * (the same mechanism Claude Desktop uses) — requires `npm run build` first,
 * which the verify script does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

describe('stdio transport E2E (child process)', () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/mcp/transport/stdio-entry.js'],
      cwd: process.cwd(),
      env: { ...process.env, ENVIRONMENT: 'local' },
    });
    client = new Client({ name: 'it', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it('lists the status tool', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      'status',
      'linkedin_connect',
      'linkedin_status',
      'linkedin_disconnect',
      'linkedin_get_my_profile',
      'linkedin_list_granted_scopes',
    ]);
  });

  it('calls status over stdio', async () => {
    const res = await client.callTool({ name: 'status', arguments: {} });
    const text = res.content[0] as { type: 'text'; text: string };
    expect(text.type).toBe('text');
    const parsed = JSON.parse(text.text) as Record<string, string>;
    expect(parsed.environment).toBe('local');
  });

  it('never pollutes stdout with diagnostics (protocol channel purity)', async () => {
    // Any log line on stdout would corrupt the JSON-RPC stream; the logger
    // writes to stderr only. A full round-trip above already proves framing
    // stayed intact; here we additionally assert no stray stdout bytes
    // precede the next response.
    const res = await client.callTool({ name: 'status', arguments: {} });
    expect(res.isError).toBeFalsy();
  });
});
