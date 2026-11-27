/**
 * HTTP entry (local dev loopback + remote staging/production deployment).
 * Usage: node dist/mcp/transport/http-entry.js
 *
 * M1: loopback-only local, plain HTTP, exact /mcp route, body cap.
 * M2: OAuth web routes (connect/callback) + mock consent route.
 * M5: the remote security + product layer:
 *   - auth middleware: session cookie / bearer API token -> authenticated
 *     tenant (AsyncLocalStorage); caller-supplied tenant ids are never read;
 *   - /auth/* routes (login/logout/state) with CSRF double-submit;
 *   - /mcp requires authentication in staging/production (401 otherwise);
 *     local remains open on loopback for M1–M4 compatibility;
 *   - /admin UI page (self-contained, CSP-safe, speaks MCP itself);
 *   - security headers on every response + request-size cap + per-IP rate
 *     limit;
 *   - /healthz for load balancers; SIGTERM/SIGINT graceful shutdown;
 *   - TLS: production/staging EXPECT termination at the proxy; this process
 *     binds HTTP_HOST only (config-enforced loopback in local).
 *
 * stdio mode (stdio-entry) is untouched by all of this.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig, type AppConfig } from '../../config/config.js';
import { createLogger } from '../../observability/logger.js';
import { buildPersistentRuntime, createMcpServer, type AppRuntime } from '../serverFactory.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { LinkedInMockProvider } from '../../auth/linkedin/mockProvider.js';
import { CallbackError, RateLimitError } from '../../auth/linkedin/connectionService.js';
import { AuthError, type UserAuthStore } from '../../auth/users/userAuthStore.js';
import { runWithTenant } from '../../identity/requestTenant.js';
import { ADMIN_PAGE_HTML } from './adminPage.js';
import { TokenBucket } from '../../usage/tokenBucket.js';
import {
  processWebhook,
  webhookStatusFor,
  type WebhookResult,
} from '../../billing/webhookRoute.js';
import { isBillingEnabled } from '../../billing/enforcement.js';
import { handleBillingApiRoutes, isBillingApiRoute } from './billingApi.js';

const log = createLogger('entry:http');

/** Request-body cap at the bridge (config: MAX_BODY_MIB, default 1 MiB). */
function maxBodyBytes(config: AppConfig): number {
  return config.MAX_BODY_MIB * 1024 * 1024;
}

function routePath(url: string | undefined): string {
  return url?.split('?')[0] ?? '';
}

function isMcpRoute(url: string | undefined): boolean {
  const path = routePath(url);
  return path === '/mcp' || path === '/mcp/';
}

/** M9 issue #13: the webhook route exists only when billing is enabled. */
function isBillingWebhookRoute(req: IncomingMessage, runtime: AppRuntime): boolean {
  if (req.method !== 'POST') {
    return false;
  }
  const path = routePath(req.url);
  if (path !== '/webhooks/razorpay') {
    return false;
  }
  // Self-hosted / disabled: the route is never mounted — a probe gets 404.
  const enforcement = runtime.billing;
  return enforcement !== undefined && isBillingEnabled(enforcement) && runtime.billingStore !== undefined;
}

/**
 * M9 issue #13: webhook handler. Raw bytes are accumulated BEFORE any JSON
 * parse (HMAC must run over the exact received bytes); the signature is
 * timing-safe-verified, the event id deduped, and the state machine applied
 * in one transaction by the store. Audit rows via the existing audit_log
 * (actor 'billing:webhook', action = event code, no payloads).
 */
async function handleBillingWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AppRuntime,
  config: AppConfig,
): Promise<void> {
  const store = runtime.billingStore;
  const enforcement = runtime.billing;
  if (store === undefined || enforcement === undefined || !isBillingEnabled(enforcement)) {
    jsonError(res, 404, 'not found');
    return;
  }
  const secret = config.RAZORPAY_WEBHOOK_SECRET ?? '';
  const signature = req.headers['x-razorpay-signature'];
  const eventId = req.headers['x-razorpay-event-id'];
  const chunks: Buffer[] = [];
  let total = 0;
  let failed = false;
  req.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > maxBodyBytes(config)) {
      failed = true; // cap BEFORE buffering (same app rule as /mcp)
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => {
    failed = true;
  });
  await new Promise<void>((resolve) => {
    req.on('end', resolve);
  });
  if (failed as boolean) {
    jsonError(res, 413, 'payload too large');
    return;
  }
  const raw = Buffer.concat(chunks);
  const audit = (action: string, detail: string): Promise<void> => {
    const s = runtime.authStore;
    if (s === undefined) return Promise.resolve();
    // Webhook actions are provider-driven (no authenticated tenant); the
    // store's audit() signature needs a tenant id — use the operator
    // system scope. Payloads are never included.
    return s.audit('system:billing', action, detail).catch(() => undefined);
  };
  const sigStr = typeof signature === 'string' ? signature : undefined;
  const evtStr = typeof eventId === 'string' ? eventId : undefined;
  let result: WebhookResult;
  try {
    result = await processWebhook(
      raw,
      sigStr,
      evtStr,
      { store, secret, maxBodyBytes: maxBodyBytes(config), audit },
    );
  } catch (err) {
    log.error('webhook processing failed', { error: err instanceof Error ? err.message : String(err) });
    result = 'invalid-payload';
  }
  // Cache invalidation so revocations take effect on the next tool call
  // (bounded by the TTL anyway; this makes it immediate for this process).
  if (result === 'verified-applied') {
    enforcement.invalidate('*');
  }
  const status = webhookStatusFor(result);
  if (status === 200) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: result === 'verified-duplicate' ? 'duplicate' : 'received' }));
    return;
  }
  jsonError(res, status, result === 'invalid-signature' ? 'invalid signature' : 'bad request');
}

/** Parse cookies into a simple map (single header, small values). */
function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  return undefined;
}

/** Security headers applied to every response this process emits. */
function secureHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('cache-control', 'no-store');
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: code }));
}

interface AuthParts {
  authStore: UserAuthStore | undefined;
  authMode: 'session' | 'mock';
}

/** Extract + validate the request credential; returns null when unauthenticated. */
async function authenticate(
  req: IncomingMessage,
  parts: AuthParts,
): Promise<{ tenantId: string; via: 'session' | 'bearer'; csrf?: string } | null> {
  if (parts.authStore === undefined) return null; // in-memory mode: open local
  const bearer = bearerToken(req);
  if (bearer !== undefined) {
    try {
      const user = await parts.authStore.resolveApiToken(bearer);
      return { tenantId: user.tenantId, via: 'bearer' };
    } catch {
      return null;
    }
  }
  const cookie = cookieValue(req, 'lkm_session');
  if (cookie !== undefined) {
    try {
      const session = await parts.authStore.resolveSession(cookie);
      return { tenantId: session.user.tenantId, via: 'session', csrf: session.csrfToken };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * OAuth web routes (owner D-A8 flow), now tenant-bound to the AUTHENTICATED
 * tenant in remote mode (state rows are per-tenant; cross-tenant state reuse
 * fails). In local in-memory mode the fixed local tenant applies.
 */
async function handleOAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AppRuntime,
  auth: { tenantId: string } | null,
): Promise<boolean> {
  const path = routePath(req.url);
  if (path !== '/linkedin/connect' && path !== '/linkedin/callback') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  // Remote mode: OAuth routes require an authenticated browser session.
  if (runtime.authStore !== undefined && auth === null) {
    jsonError(res, 401, 'authentication required');
    return true;
  }
  // Tenant for OAuth routes: the authenticated user's tenant, or the
  // LOCAL_DEV_TENANT constant (NOT a hand-rolled tenant object — the vault
  // keys include userId, so a mismatched userId splits the token store).
  const tenantCtx = auth !== null
    ? { tenantId: auth.tenantId, userId: auth.tenantId }
    : runtime.tenant;
  if (path === '/linkedin/connect') {
    try {
      const start = await runtime.connection.connect(tenantCtx);
      log.info('oauth connect redirect', { tenant: tenantCtx.tenantId });
      res.writeHead(303, { location: start.authorizationUrl });
      res.end();
    } catch (err) {
      if (err instanceof RateLimitError) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limit: too many connect attempts; retry later' }));
      } else {
        log.error('connect route failed', { error: err instanceof Error ? err.message : String(err) });
        jsonError(res, 500, 'failed to start connection flow');
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
    jsonError(res, 400, 'missing state or code');
    return true;
  }
  // Redirect-safety: callback only ever 200s/400s — it never redirects to a
  // caller-controlled target, so no open-redirect surface exists here.
  try {
    const status = await runtime.connection.handleCallback(tenantCtx, state, code);
    log.info('oauth callback accepted', { scopes: status.scopes.join(' '), tenant: tenantCtx.tenantId });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        connected: true,
        expiresAt: status.expiresAt,
        scopes: status.scopes,
        memberId: status.memberId,
      }),
    );
  } catch (err) {
    if (err instanceof CallbackError) {
      const status = err.code === 'state' ? 400 : 502;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      log.error('callback failed', { error: err instanceof Error ? err.message : String(err) });
      jsonError(res, 500, 'callback handling failed');
    }
  }
  return true;
}

/**
 * Mock-provider consent route (local mock OAuth only, unchanged from M2).
 */
function handleMockAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AppRuntime,
): boolean {
  const path = routePath(req.url);
  if (path !== '/mock/linkedin/authorize') return false;
  const provider = (runtime as { mockProvider?: LinkedInMockProvider }).mockProvider;
  if (runtime.config.OAUTH_PROVIDER !== 'mock' || provider === undefined) {
    jsonError(res, 404, 'mock provider not active');
    return true;
  }
  const url = new URL(req.url ?? '/', `http://${runtime.config.HTTP_HOST}:${String(runtime.config.HTTP_PORT)}`);
  const state = url.searchParams.get('state') ?? '';
  const redirectUri = url.searchParams.get('redirect_uri') ?? 'http://127.0.0.1/mock-callback';
  if (state === '') {
    jsonError(res, 400, 'missing state');
    return true;
  }
  // redirect_uri is bounded: only the configured callback origin is honored
  // (default loopback) — no arbitrary third-party redirect.
  const back = new URL(redirectUri);
  if (back.hostname !== '127.0.0.1' && back.hostname !== 'localhost' && back.hostname !== runtime.config.HTTP_HOST) {
    jsonError(res, 400, 'redirect_uri not allowed');
    return true;
  }
  const code = provider.issueCode(['openid', 'profile', 'email', 'w_member_social']);
  back.searchParams.set('code', code);
  back.searchParams.set('state', state);
  res.writeHead(303, { location: back.toString() });
  res.end();
  return true;
}

/** Read a JSON body with a hard byte cap. */
function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.removeAllListeners('data');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Auth + product routes (M5):
 *   POST /auth/login    {username,password}  -> session cookie + CSRF token
 *   POST /auth/logout   (CSRF)               -> revoke session
 *   GET  /auth/state                          -> who am I (safe fields only)
 *   GET  /admin                                -> the UI page
 *   GET  /healthz                              -> liveness (no auth)
 */
async function handleAuthAndUiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AppRuntime,
  auth: { tenantId: string; via: 'session' | 'bearer'; csrf?: string } | null,
  authStore: UserAuthStore | undefined,
): Promise<boolean> {
  const path = routePath(req.url);
  const isUi = path === '/admin' || path === '/admin/';
  const isAuthRoute = path.startsWith('/auth/');
  if (!isUi && !isAuthRoute && path !== '/healthz') return false;

  if (path === '/healthz') {
    if (req.method !== 'GET') {
      jsonError(res, 405, 'method not allowed');
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, backend: runtime.storageBackend, env: runtime.config.ENVIRONMENT }));
    return true;
  }

  if (isUi) {
    if (req.method !== 'GET') {
      jsonError(res, 405, 'method not allowed');
      return true;
    }
    // The page is static; auth state is fetched by the client itself.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ADMIN_PAGE_HTML);
    return true;
  }

  // --- /auth/* routes ---
  if (authStore === undefined) {
    // in-memory local mode: no user database configured.
    jsonError(res, 503, 'authentication not configured (no DATABASE_URL)');
    return true;
  }
  if (path === '/auth/login' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, maxBodyBytes(runtime.config));
      const username = typeof String(body.username) === 'string' ? String(body.username) : '';
      const password = typeof String(body.password) === 'string' ? String(body.password) : '';
      if (username === '' || password === '') {
        jsonError(res, 400, 'username and password required');
        return true;
      }
      const user = await authStore.verifyCredential(username, password);
      const session = await authStore.issueSession(user);
      await authStore.audit(user.tenantId, user.username, 'login', 'session issued');
      // HttpOnly + SameSite=Lax (the OAuth redirect chain needs Lax so the
      // callback fetch carries the cookie) + Secure in staging/production.
      const secure = runtime.config.ENVIRONMENT === 'local' ? '' : '; Secure';
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `lkm_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(runtime.config.SESSION_TTL_SECONDS))}${secure}`,
      });
      res.end(JSON.stringify({
        authenticated: true,
        username: user.username,
        tenantId: user.tenantId,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      }));
    } catch (err) {
      if (err instanceof AuthError) {
        // Uniform message; never reveal which factor failed.
        jsonError(res, 401, 'invalid credentials');
        return true;
      }
      if (err instanceof Error && err.message === 'payload too large') {
        jsonError(res, 413, 'payload too large');
        return true;
      }
      log.error('login route failed', { error: err instanceof Error ? err.message : String(err) });
      jsonError(res, 500, 'login failed');
    }
    return true;
  }
  if (path === '/auth/logout' && req.method === 'POST') {
    const cookie = cookieValue(req, 'lkm_session');
    if (cookie === undefined || auth === null) {
      jsonError(res, 401, 'authentication required');
      return true;
    }
    // CSRF: session cookie + header double-submit.
    const headerRaw = req.headers['x-csrf-token'];
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    if (auth.via !== 'session' || !authStore.verifyCsrfDigest(auth.csrf ?? '', header)) {
      jsonError(res, 403, 'csrf validation failed');
      return true;
    }
    await authStore.revokeSession(cookie);
    if (auth.tenantId) await authStore.audit(auth.tenantId, 'user', 'logout', 'session revoked');
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'lkm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
    res.end(JSON.stringify({ authenticated: false }));
    return true;
  }
  if (path === '/auth/state' && req.method === 'GET') {
    if (auth === null) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authenticated: false }));
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      authenticated: true,
      tenantId: auth.tenantId,
      via: auth.via,
    }));
    return true;
  }
  jsonError(res, 404, 'not found');
  return true;
}

/**
 * MCP request bridge: absorb the body with the byte cap, then forward the
 * web-standard Request to the SDK handler — all inside the tenant ALS
 * scope so tool calls resolve the authenticated tenant.
 */
function setupBodyBridge(
  req: IncomingMessage,
  res: ServerResponse,
  tenantCtx: { tenantId: string; userId: string },
  config: AppConfig,
  handler: ReturnType<typeof createMcpHandler>,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > maxBodyBytes(config)) {
      oversized = true;
      chunks.length = 0;
      req.removeAllListeners('data');
      jsonError(res, 413, 'payload too large');
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (oversized) return;
    // Re-enter the tenant scope for the SDK's async chain.
    runWithTenant(tenantCtx, () => {
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
          const out = Buffer.from(await resp.arrayBuffer());
          res.end(out);
        })
        .catch((err: unknown) => {
          log.error('fetch bridge failed', { error: err instanceof Error ? err.message : String(err) });
          jsonError(res, 500, 'internal');
        });
    });
  });
  req.on('error', (err: Error) => {
    log.warn('request stream error', { error: err.message });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await buildPersistentRuntime(config);
  const handler = createMcpHandler(() => createMcpServer(runtime), {
    onerror: (err) => {
      log.error('http handler error', { error: err.message });
    },
  });

  const authParts: AuthParts = {
    authStore: runtime.authStore,
    authMode: config.AUTH_MODE,
  };
  // Per-IP rate limiter (in-process fixed window).
  const ipBuckets = new Map<string, TokenBucket>();
  const rateLimit = (ip: string): boolean => {
    let b = ipBuckets.get(ip);
    if (b === undefined) {
      b = new TokenBucket({ key: `ip:${ip}`, capacity: config.HTTP_RATE_LIMIT_PER_MINUTE, windowMs: 60_000 });
      ipBuckets.set(ip, b);
    }
    return b.take();
  };

  const server = createServer((req, res) => {
    secureHeaders(res);
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!rateLimit(ip)) {
      jsonError(res, 429, 'rate limit exceeded');
      return;
    }
    void (async () => {
      try {
        const auth = await authenticate(req, authParts);
        // Remote mode: /mcp and OAuth routes require authentication.
        const authRequired = runtime.authStore !== undefined;
        if (await handleAuthAndUiRoutes(req, res, runtime, auth, runtime.authStore)) return;
        if (await handleOAuthRoutes(req, res, runtime, auth)) return;
        if (handleMockAuthorize(req, res, runtime)) return;
        // M9 issue #13: provider webhook route (mounted ONLY when billing is
        // enabled; raw-body capture precedes ALL parsing because the HMAC is
        // computed over the exact received bytes).
        if (isBillingWebhookRoute(req, runtime)) {
          await handleBillingWebhook(req, res, runtime, config);
          return;
        }
        // M9: authenticated billing REST API for the console UI (mounted
        // only when billing is enabled; disabled servers 404 via the
        // fall-through below — self-hosted boundary).
        if (isBillingApiRoute(req, runtime)) {
          await handleBillingApiRoutes(req, res, {
            runtime,
            config,
            auth,
            authStore: runtime.authStore,
          });
          return;
        }
        if (!isMcpRoute(req.url)) {
          jsonError(res, 404, 'not found');
          return;
        }
        if (authRequired && auth === null) {
          jsonError(res, 401, 'authentication required');
          return;
        }
        // Authenticated tenant from the credential; the fixed local-dev
        // tenant constant otherwise (same object the tools use).
        const tenantCtx = auth !== null
          ? { tenantId: auth.tenantId, userId: auth.tenantId }
          : runtime.tenant;
        // The MCP handler + tools run with the AUTHENTICATED tenant
        // installed. The scope is re-entered inside 'end' so the SDK's
        // async chain resolves tools with the right tenant.
        runWithTenant(tenantCtx, () => {
          setupBodyBridge(req, res, tenantCtx, config, handler);
        });
      } catch (err) {
        log.error('request dispatch failed', { error: err instanceof Error ? err.message : String(err) });
        jsonError(res, 500, 'internal');
      }
    })();
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
    storage: runtime.storageBackend,
    auth: runtime.authStore !== undefined ? 'session' : 'none (local)',
  });

  // Graceful shutdown: stop accepting, close DB, exit.
  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    server.close(() => {
      void runtime.close().then(() => {
        process.exit(0);
      });
    });
    // Hard stop if the graceful path hangs.
    setTimeout(() => {
      process.exit(1);
    }, 10_000).unref();
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}

void main();
