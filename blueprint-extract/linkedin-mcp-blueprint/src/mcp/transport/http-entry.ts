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

/**
 * Request-body cap at the bridge. The SDK handler's own bound applies only
 * to bodies it reads itself; a pre-built Request bypasses it, so the node:http
 * layer must enforce its own limit. 4 MiB mirrors the SDK default.
 */
const MAX_BODY_BYTES = 4_194_304;

function isMcpRoute(url: string | undefined): boolean {
  if (url === undefined) return false;
  const path = url.split('?')[0] ?? '';
  return path === '/mcp' || path === '/mcp/';
}

async function main(): Promise<void> {
  const config = loadConfig();
  const handler = createMcpHandler(() => createMcpServer(config), {
    onerror: (err) => {
      log.error('http handler error', { error: err.message });
    },
  });

  const server = createServer((req, res) => {
    if (!isMcpRoute(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    // Bridge node req/res to the web-standard handler.
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        // Stop absorbing the body; drain the socket without buffering.
        chunks.length = 0;
        req.removeAllListeners('data');
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (oversized) return;
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
    req.on('error', (err: Error) => {
      log.warn('request stream error', { error: err.message });
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
