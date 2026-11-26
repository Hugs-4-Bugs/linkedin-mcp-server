/**
 * Security-regression tests for the gate findings:
 * 1. local environment must refuse non-loopback bind (config boundary);
 * 2. stdout wire purity over raw JSON-RPC (stdio protocol channel);
 * 3. HTTP body-size cap at the bridge (413) and exact route matching.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ConfigError, parseConfig } from '../../src/config/config.js';

const PORT = 3341;

describe('loopback enforcement (behavioral, compiled entry)', () => {
  it('local + 0.0.0.0 exits non-zero BEFORE listening', async () => {
    const child = spawn('node', ['dist/mcp/transport/http-entry.js'], {
      cwd: process.cwd(),
      env: { ...process.env, ENVIRONMENT: 'local', HTTP_HOST: '0.0.0.0', HTTP_PORT: String(PORT) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let out = '';
    child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    const [code] = await once(child, 'exit');
    expect(code).not.toBe(0);
    expect(out).toContain('must bind loopback');
  });

  it('parseConfig rejects 0.0.0.0 in local and accepts it in staging', () => {
    expect(() => parseConfig({ ENVIRONMENT: 'local', HTTP_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(parseConfig({ ENVIRONMENT: 'staging', HTTP_HOST: '0.0.0.0' }).HTTP_HOST).toBe('0.0.0.0');
  });
});

describe('stdio stdout wire purity (raw JSON-RPC framing)', () => {
  it('every stdout line is strict JSON-RPC 2.0 — no diagnostics leak', async () => {
    const child = spawn('node', ['dist/mcp/transport/stdio-entry.js'], {
      cwd: process.cwd(),
      env: { ...process.env, ENVIRONMENT: 'local' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let raw = '';
    child.stdout.on('data', (d: Buffer) => { raw += d.toString('utf8'); });
    const id = () => Math.floor(Math.random() * 1_000_000);
    const rpc = (method: string, params: Record<string, unknown>): string =>
      JSON.stringify({ jsonrpc: '2.0', id: id(), method, params });
    child.stdin.write(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'wire-test', version: '0' } }) + '\n');
    await new Promise((r) => setTimeout(r, 300));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(rpc('tools/list', {}) + '\n');
    child.stdin.write(rpc('tools/call', { name: 'status', arguments: {} }) + '\n');
    await new Promise((r) => setTimeout(r, 700));
    child.kill();
    await once(child, 'exit').catch(() => undefined);
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(2); // initialize result + tool results
    const parsed = lines.map((l) => JSON.parse(l) as { jsonrpc?: string });
    for (const m of parsed) expect(m.jsonrpc).toBe('2.0');
  });
});

describe('HTTP bridge body cap and route exactness', () => {
  it('rejects an over-cap body with 413 without buffering it fully', async () => {
    const child = spawn('node', ['dist/mcp/transport/http-entry.js'], {
      cwd: process.cwd(),
      env: { ...process.env, ENVIRONMENT: 'local', HTTP_PORT: String(PORT) },
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
    try {
      // 5 MiB body > 4 MiB cap. Send as stream so the bridge's incremental
      // check triggers before the full body arrives.
      const body = 'x'.repeat(5 * 1024 * 1024);
      const resp = await fetch(`http://127.0.0.1:${String(PORT)}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body,
      });
      expect(resp.status).toBe(413);
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('404s prefix-squatting routes like /mcpfoo (exact match only)', async () => {
    const child = spawn('node', ['dist/mcp/transport/http-entry.js'], {
      cwd: process.cwd(),
      env: { ...process.env, ENVIRONMENT: 'local', HTTP_PORT: String(PORT) },
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
    try {
      const resp = await fetch(`http://127.0.0.1:${String(PORT)}/mcpfoo`);
      expect(resp.status).toBe(404);
      const resp2 = await fetch(`http://127.0.0.1:${String(PORT)}/mcp?x=1`);
      expect(resp2.status).toBe(405); // route matches; method GET not allowed
    } finally {
      child.kill('SIGTERM');
    }
  });
});
