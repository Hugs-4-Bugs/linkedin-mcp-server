/**
 * M9 issues #13/#14 — authenticated billing REST API for the console UI.
 *
 * Sits beside /auth/* routes in http-entry (same middleware discipline):
 *   GET  /api/billing/summary   -> dashboard payload (subscription, usage,
 *                                  plan catalog, billingMode) in one call
 *   POST /api/billing/checkout   -> initiate hosted checkout (test mode)
 *   POST /api/billing/cancel     -> request subscription cancellation
 *
 * Server-authoritative rules (tests enforce each):
 *   - Tenant identity comes ONLY from the authenticated session (cookie).
 *     No request field can select or override the tenant.
 *   - Plan catalog + prices come from the SERVER config (BILLING_PLAN_LIMITS
 *     + per-plan pricing map), never from the client.
 *   - Checkout returns a payment-pending state; entitlement changes ONLY
 *     when a verified provider webhook applies (webhookRoute). This API
 *     never writes subscription/entitlement rows.
 *   - Cancellation is a REQUEST recorded via audit + the provider console;
 *     the actual revocation arrives as 'subscription.cancelled' webhook
 *     (the documented Razorpay model: cancel at period end by default).
 *     No local entitlement row is mutated here — no cancellation bypass.
 *   - Mounted ONLY when billing is enabled; a disabled server 404s these
 *     routes (self-hosted boundary, same rule as /webhooks/razorpay).
 *
 * Response schema is deliberately flat + total: the UI renders exactly
 * what the server says, never inventing dates or statuses.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../../observability/logger.js';
import type { AppConfig } from '../../config/config.js';
import type { AppRuntime } from '../serverFactory.js';
import { isBillingEnabled } from '../../billing/enforcement.js';
import { entitlementUsable } from '../../billing/subscriptionStateMachine.js';

const log = createLogger('billing:api');

/** Per-plan hosted pricing (test-mode display currency; INR paise are
 * avoided — the provider test dashboard quotes whole rupees). */
export const PLAN_PRICES_INR: Readonly<Record<string, number>> = {
  pro: 999,
  team: 4999,
};

const BILLING_WINDOW_MS = 30 * 86_400_000;
const COUNTER = 'tool-calls';

export interface BillingApiParts {
  runtime: AppRuntime;
  config: AppConfig;
  /** Authenticated tenant from the session middleware (never client-set).
   * `via` distinguishes console sessions from bearer API tokens — billing
   * management accepts SESSIONS only (issue #32). */
  auth: { tenantId: string; via: 'session' | 'bearer' } | null;
  authStore: import('../../auth/users/userAuthStore.js').UserAuthStore | undefined;
}

/** Is this request a billing API route? (Mounted check happens inside.) */
export function isBillingApiRoute(req: IncomingMessage, runtime: AppRuntime): boolean {
  const path = req.url?.split('?')[0] ?? '';
  if (!path.startsWith('/api/billing/')) return false;
  const enforcement = runtime.billing;
  return enforcement !== undefined && isBillingEnabled(enforcement) && runtime.billingStore !== undefined;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function jsonErr(res: ServerResponse, status: number, code: string): void {
  json(res, status, { error: code });
}

/** Parse the request body with a hard cap (same rule as /auth/login). */
function readBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
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

function parseLimits(config: AppConfig): Record<string, number> {
  try {
    const parsed = JSON.parse(config.BILLING_PLAN_LIMITS) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0)
          .map(([k, v]) => [k, v as number]),
      );
    }
  } catch {
    log.warn('BILLING_PLAN_LIMITS unparsable; empty catalog (fail-closed)');
  }
  return {};
}

/** Server-side plan catalog (the ONLY source the UI may render). */
export interface PlanCatalogEntry {
  planId: string;
  monthlyToolCalls: number;
  priceInr: number | null;
  currency: string;
  billingInterval: string;
}

export function planCatalog(config: AppConfig): PlanCatalogEntry[] {
  const limits = parseLimits(config);
  return Object.entries(limits)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([planId, monthlyToolCalls]) => ({
      planId,
      monthlyToolCalls,
      priceInr: PLAN_PRICES_INR[planId] ?? null,
      currency: 'INR',
      billingInterval: 'monthly',
    }));
}

/** CSRF double-submit (same discipline as /auth/logout). */
function csrfOk(
  req: IncomingMessage,
  auth: { tenantId: string; csrf?: string } | null,
  authStore: BillingApiParts['authStore'],
): boolean {
  if (auth === null || authStore === undefined) return false;
  const header = req.headers['x-csrf-token'];
  const presented = typeof header === 'string' ? header : undefined;
  return authStore.verifyCsrfDigest(auth.csrf ?? '', presented);
}

/**
 * Handle one /api/billing/* request. Returns true when the route matched
 * (response written), false otherwise (caller falls through to 404).
 */
export async function handleBillingApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: BillingApiParts,
): Promise<boolean> {
  const { runtime, config } = parts;
  const store = runtime.billingStore;
  if (store === undefined) return false; // unreachable: mount check above
  const path = req.url?.split('?')[0] ?? '';

  // Mounted only under enabled billing — disabled servers never see it.
  const enforcement = runtime.billing;
  if (enforcement === undefined || !isBillingEnabled(enforcement) || runtime.billingStore === undefined) {
    return false;
  }

  // All billing API routes require an authenticated SESSION — never the
  // bearer API-token path (issue #32: billing management is a console
  // browser flow; the previous `auth !== null` check let bearer tokens
  // read the GET summary despite the comment claiming otherwise).
  if (parts.auth?.via !== 'session') {
    jsonErr(res, 401, 'session authentication required');
    return true;
  }
  const tenantId = parts.auth.tenantId; // server-authoritative

  // ---- GET /api/billing/summary : the dashboard payload ----
  if (path === '/api/billing/summary' && req.method === 'GET') {
    try {
      const now = Date.now();
      const limits = parseLimits(config);
      const sub = await store.entitlementOf(tenantId, now);
      const usage = await store.usageOf(tenantId, COUNTER);
      const rawSub = await store.subscriptionOf(tenantId);
      const planId = sub?.planId ?? '';
      const capacity = planId !== '' ? (limits[planId] ?? 0) : 0;
      const used = usage?.used ?? 0;
      json(res, 200, {
        billingMode: 'hosted (test)',
        provider: 'razorpay',
        tenantId,
        subscription: sub === undefined ? null : {
          subscriptionId: sub.subscriptionId,
          planId: sub.planId,
          providerStatus: sub.providerStatus,
          entitlementStatus: sub.entitlementStatus,
          graceEndsAt: sub.graceEndsAt,
          updatedAt: sub.updatedAt,
          usable: entitlementUsable(sub.entitlementStatus, now, sub.graceEndsAt),
        },
        rawProviderStatus: rawSub?.providerStatus ?? null,
        usage: {
          counter: COUNTER,
          periodDays: Math.round(BILLING_WINDOW_MS / 86_400_000),
          used,
          limit: capacity,
          remaining: capacity > 0 ? Math.max(0, capacity - used) : 0,
          exhausted: capacity > 0 && used >= capacity,
        },
        plans: planCatalog(config),
        checkoutSupported: true,
      });
    } catch (err) {
      log.error('billing summary failed', { error: err instanceof Error ? err.message : String(err) });
      jsonErr(res, 503, 'billing summary unavailable');
    }
    return true;
  }

  // ---- POST /api/billing/checkout : initiate hosted checkout ----
  if (path === '/api/billing/checkout' && req.method === 'POST') {
    if (!csrfOk(req, parts.auth, parts.authStore)) {
      jsonErr(res, 403, 'csrf required');
      return true;
    }
    const body = await readBody(req, config.MAX_BODY_MIB * 1024 * 1024).catch((err: unknown): null => {
      const msg = err instanceof Error ? err.message : String(err);
      jsonErr(res, msg === 'payload too large' ? 413 : 400, msg === 'payload too large' ? 'payload too large' : 'invalid JSON');
      return null;
    });
    if (body === null) return true;
    const planId = typeof body.planId === 'string' ? body.planId : '';
    const limits = parseLimits(config);
    // Fail-closed: unknown/unmapped plans are rejected, never guessed.
    if (planId === '' || !(planId in limits)) {
      jsonErr(res, 400, 'unknown plan');
      return true;
    }
    // Test-mode checkout: the provider's hosted page is reached through the
    // OPERATOR-configured dashboard; in test mode we return the deterministic
    // handshake the UI needs (plan + price + pending state). NO local
    // entitlement write — only a webhook can activate a subscription.
    const price = PLAN_PRICES_INR[planId] ?? null;
    try {
      await parts.authStore?.audit(tenantId, 'user', 'billing:checkout-initiated', `plan:${planId}`);
    } catch { /* audit is log-only, never blocks the flow */ }
    json(res, 200, {
      status: 'pending',
      planId,
      priceInr: price,
      currency: 'INR',
      billingInterval: 'monthly',
      message: 'Checkout initiated. Payment confirmation arrives via provider webhook; access activates only after the server verifies it.',
      // The hosted checkout URL is provider-dashboard-configured; in test
      // mode the UI completes the handshake deterministically (see UI).
      checkoutUrl: null,
    });
    return true;
  }

  // ---- POST /api/billing/cancel : request subscription cancellation ----
  if (path === '/api/billing/cancel' && req.method === 'POST') {
    if (!csrfOk(req, parts.auth, parts.authStore)) {
      jsonErr(res, 403, 'csrf required');
      return true;
    }
    try {
      await readBody(req, config.MAX_BODY_MIB * 1024 * 1024);
    } catch {
      // body is optional here; a JSON read failure is still a bad request
      jsonErr(res, 400, 'invalid JSON');
      return true;
    }
    const now = Date.now();
    const sub = await store.entitlementOf(tenantId, now);
    if (sub === undefined) {
      jsonErr(res, 409, 'no subscription to cancel');
      return true;
    }
    // Cancellation is recorded as a REQUEST. The authoritative revocation
    // arrives as 'subscription.cancelled' from the provider webhook (the
    // state machine then revokes immediately — ADR-023). We deliberately do
    // NOT write subscription rows here: the UI stays non-authoritative.
    try {
      await parts.authStore?.audit(tenantId, 'user', 'billing:cancel-requested', `plan:${sub.planId}`);
    } catch { /* audit is log-only */ }
    json(res, 200, {
      status: 'cancel-requested',
      planId: sub.planId,
      subscriptionId: sub.subscriptionId,
      effective: 'provider-confirmed (revocation lands via verified webhook)',
      message: 'Cancellation requested. The subscription stays active until the provider confirms via webhook.',
    });
    return true;
  }

  jsonErr(res, 404, 'not found');
  return true;
}
