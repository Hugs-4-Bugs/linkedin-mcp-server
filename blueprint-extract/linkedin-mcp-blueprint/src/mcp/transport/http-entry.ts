/**
 * HTTP entry (local dev loopback + staging Streamable HTTP).
 * Usage: node dist/mcp/transport/http-entry.js
 *
 * M1: binds loopback in local env (enforced by config), plain HTTP only.
 * TLS termination at 443 happens at the hosting layer in staging (M5) —
 * this process must not serve plaintext on a public interface.
 */
import { createServer } from 'node:http';
import { loadConfig } from '../../config/config.js';
import { createLogger } from '../../observability/logger.js';
import { createMcpServer } from '../serverFactory.js';
import { createMcpHandler } from '@modelcontextprotocol/server';

const log = createLogger('entry:http');

async function main(): Promise<void> {
  const config = loadConfig();
  const handler = createMcpHandler(() => createMcpServer(config), {
    onerror: (err) => {
      log.error('http handler error', { error: err.message });
    },
  });

  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    // Bridge node req/res to the web-standard handler.
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = `http://${config.HTTP_HOST}:${String(config.HTTP_PORT)}${req.url ?? ''}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
      }
      const init: RequestInit = { method: req.method ?? 'GET', headers };
      const buf = Buffer.concat(chunks);
      if (buf.length > 0) init.body = new Uint8Array(buf);
      handler
        .fetch(new Request(url, init))
        .then(async (resp) => {
          res.writeHead(resp.status, Object.fromEntries(resp.headers.entries()));
          const buf = Buffer.from(await resp.arrayBuffer());
          res.end(buf);
        })
        .catch((err: unknown) => {
          log.error('fetch bridge failed', { error: err instanceof Error ? err.message : String(err) });
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal' }));
        });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(config.HTTP_PORT, config.HTTP_HOST, () => {
      resolve();
    });
  });
  log.info('http MCP server started', {
    host: config.HTTP_HOST,
    port: config.HTTP_PORT,
    route: '/mcp',
    environment: config.ENVIRONMENT,
  });
}

void main();
