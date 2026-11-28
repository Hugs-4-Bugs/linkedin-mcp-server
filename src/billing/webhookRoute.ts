/**
 * M9 issue #13 — Razorpay webhook HTTP route.
 *
 * Raw-body capture happens BEFORE any JSON parsing: HMAC must be computed
 * over the exact received bytes (provider docs: "Do not parse or cast the
 * webhook request body"). Flow:
 *
 *   POST /webhooks/razorpay
 *     1. size cap (reuse MAX_BODY_MIB app rule)
 *     2. HMAC-SHA256 timing-safe verification (X-Razorpay-Signature)
 *     3. event-id dedupe + payload validation
 *     4. single-transaction apply (store.applyEvent) + audit row
 *     5. respond 200 {status:'received'} | 400 | 500 (never 200 on failure)
 *
 * The route exists ONLY when billing is enabled and mounted with a
 * configured secret — self-hosted servers never register it.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import { WebhookVerificationError, parseSubscriptionEvent, verifyRazorpaySignature } from './providerEvents.js';
import type { BillingStore } from './billingStore.js';

const log = createLogger('billing:webhook');

/** Audit sink contract the route uses (same shape as the M7 tool audit). */
export type BillingAudit = (action: string, detail: string) => Promise<void>;

export interface WebhookRouteOptions {
  store: BillingStore;
  secret: string;
  /** Application body cap in bytes (config.MAX_BODY_MIB). */
  maxBodyBytes: number;
  audit?: BillingAudit;
  now?: () => number;
  /** Redaction guard: the secret must never appear in any log line. */
  logSink?: (line: string) => void;
}

/** Result shape for tests + the HTTP entry. */
export type WebhookResult = 'verified-applied' | 'verified-duplicate' | 'invalid-signature' | 'invalid-payload' | 'too-large';

/**
 * Process one webhook request (transport-agnostic core so tests drive it
 * directly with Buffers; http-entry wires the actual socket handling).
 */
export async function processWebhook(
  rawBody: Buffer,
  signature: string | undefined,
  /**
   * x-razorpay-event-id header value. NOT trusted for dedupe anymore
   * (issue #26): when the signed body lacks event_id the key is derived
   * from the signed content. Parameter kept for signature compatibility.
   */
  _eventId: string | undefined,
  opts: WebhookRouteOptions,
): Promise<WebhookResult> {
  const now = opts.now?.() ?? Date.now();
  if (rawBody.length === 0 || rawBody.length > opts.maxBodyBytes) {
    log.warn('webhook rejected: size', { bytes: rawBody.length });
    return 'too-large';
  }
  if (!verifyRazorpaySignature(rawBody, signature, opts.secret)) {
    // NEVER log the secret or the body — redaction rule (test-enforced).
    log.warn('webhook signature invalid', { bytes: rawBody.length });
    return 'invalid-signature';
  }
  let event;
  try {
    event = parseSubscriptionEvent(rawBody);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return 'invalid-payload';
    }
    throw err;
  }
  if (event.eventId === '') {
    // Issue #26 (replay window): the body has no event_id. The dedupe
    // key MUST be derived from the signed content — never from the
    // unauthenticated x-razorpay-event-id header (the HMAC covers only
    // the body, so a captured validly-signed replay with varied header
    // ids used to insert fresh rows and re-apply the event).
    // sha256(body||signature) is deterministic for the same signed
    // delivery: replays collide and dedupe, regardless of headers.
    const derived = createHash('sha256')
      .update(rawBody)
      .update(signature ?? '')
      .digest('hex');
    event = { ...event, eventId: `derived:${derived}` };
  }
  const outcome = await opts.store.applyEvent(event, now);
  try {
    await opts.audit?.(`billing:webhook:${event.code}`, outcome === 'duplicate' ? 'duplicate' : 'applied');
  } catch (auditErr) {
    // Audit failure must not change the webhook outcome (same rule as M7).
    log.warn('billing audit failed', { error: auditErr instanceof Error ? auditErr.message : String(auditErr) });
  }
  if (outcome === 'applied') {
    log.info('webhook applied', { code: event.code, tenant: event.tenantId, eventId: event.eventId });
  } else {
    log.info('webhook duplicate (idempotent no-op)', { code: event.code, eventId: event.eventId });
  }
  return outcome === 'applied' ? 'verified-applied' : 'verified-duplicate';
}

/** HTTP status for a result (the exact response contract). */
export function webhookStatusFor(result: WebhookResult): number {
  switch (result) {
    case 'verified-applied':
    case 'verified-duplicate':
      return 200;
    case 'invalid-signature':
    case 'invalid-payload':
    case 'too-large':
      return 400;
  }
}

/**
 * Deterministic test helpers: build a signed webhook exactly the way
 * Razorpay does (HMAC-SHA256 hex over raw body with the secret).
 */
export function signRazorpayBody(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Timing-safe equality re-export for tests that verify our comparisons. */
export { timingSafeEqual };
