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
import { buildRuntime, createMcpServer, type AppRuntime } from '../serverFactory.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { LinkedInMockProvider } from '../../auth/linkedin/mockProvider.js';
import { CallbackError, RateLimitError } from '../../auth/linkedin/connectionService.js';

const log = createLogger('entry:http');

/**
 * Request-body cap at the bridge. The SDK handler's own bound applies only
 * to bodies it reads itself; a pre-built Request bypasses it, so the node:http
 * layer must enforce its own limit. 4 MiB mirrors the SDK default.
 */
const MAX_BODY_BYTES = 4_194_304;

function routePath(url: string | undefined): string {
  return url?.split('?')[0] ?? '';
}

function isMcpRoute(url: string | undefined): boolean {
  const path = routePath(url);
  return path === '/mcp' || path === '/mcp/';
}

/**
 * OAuth web routes (owner D-A8 flow):
 *   GET /linkedin/connect  → start flow; 303 redirect to the authorization URL
 *   GET /linkedin/callback → state + code validation; tokens sealed
 *
 * The browser-facing connect route issues the flow for the local tenant;
 * hosted multi-tenant correlation arrives with the identity layer (M5+).
 */
function handleOAuthRoutes(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, runtime: AppRuntime): boolean {
  const path = routePath(req.url);
  if (path !== '/linkedin/connect' && path !== '/linkedin/callback') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  if (path === '/linkedin/connect') {
    try {
      const start = runtime.connection.connect(runtime.tenant);
      log.info('oauth connect redirect', {});
      res.writeHead(303, { location: start.authorizationUrl });
      res.end();
    } catch (err) {
      if (err instanceof RateLimitError) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limit: too many connect attempts; retry later' }));
      } else {
        log.error('connect route failed', { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'failed to start connection flow' }));
      }
    }
    return true;
  }
  // /linkedin/callback
  const url = new URL(req.url ?? '/', `http://${runtime.config.HTTP_HOST}:${String(runtime.config.HTTP_PORT)}`);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const errorParam = url.searchParams.get('error');
  if (errorParam !== null) {
    log.info('oauth callback error param', { errorParam });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'LinkedIn returned an authorization error', detail: errorParam }));
    return true;
  }
  if (state === '' || code === '') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing state or code' }));
    return true;
  }
  runtime.connection
    .handleCallback(runtime.tenant, state, code)
    .then((status) => {
      log.info('oauth callback accepted', { scopes: status.scopes.join(' ') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          connected: true,
          expiresAt: status.expiresAt,
          scopes: status.scopes,
          memberId: status.memberId,
        }),
      );
    })
    .catch((err: unknown) => {
      if (err instanceof CallbackError) {
        const status = err.code === 'state' ? 400 : 502;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        log.error('callback failed', { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'callback handling failed' }));
      }
    });
  return true;
}

/**
 * Mock-provider helper route (owner M2 directive: mock OAuth so the flow is
 * drivable without credentials). Only mounted when OAUTH_PROVIDER=mock:
 * it approves the authorization "page" by issuing a code and bouncing back
 * to the callback with it, simulating LinkedIn's consent screen.
 */
function handleMockAuthorize(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, runtime: AppRuntime): boolean {
  const path = routePath(req.url);
  if (path !== '/mock/linkedin/authorize') return false;
  const provider = (runtime as { mockProvider?: LinkedInMockProvider }).mockProvider;
  if (runtime.config.OAUTH_PROVIDER !== 'mock' || provider === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'mock provider not active' }));
    return true;
  }
  const url = new URL(req.url ?? '/', `http://${runtime.config.HTTP_HOST}:${String(runtime.config.HTTP_PORT)}`);
  const state = url.searchParams.get('state') ?? '';
  const redirectUri = url.searchParams.get('redirect_uri') ?? 'http://127.0.0.1/mock-callback';
  if (state === '') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing state' }));
    return true;
  }
  const code = provider.issueCode(['openid', 'profile', 'email', 'w_member_social']);
  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  back.searchParams.set('state', state);
  res.writeHead(303, { location: back.toString() });
  res.end();
  return true;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = buildRuntime(config);
  const handler = createMcpHandler(() => createMcpServer(runtime), {
    onerror: (err) => {
      log.error('http handler error', { error: err.message });
    },
  });

  const server = createServer((req, res) => {
    if (handleOAuthRoutes(req, res, runtime)) return;
    if (handleMockAuthorize(req, res, runtime)) return;
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
