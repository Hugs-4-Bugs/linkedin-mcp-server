/**
 * M9 issue #13 — payment provider event contract + webhook verification.
 *
 * Provider-agnostic shape (ADR-024): the billing subsystem consumes
 * `PaymentProviderEvent`s; the Razorpay adapter is the only provider
 * implementation (test mode only). Verification is plain node:crypto
 * HMAC-SHA256 over the RAW request bytes — no SDK dependency, no
 * re-serialization, exactly the provider's documented scheme:
 *
 *   signature = hex(HMAC-SHA256(key = webhook secret, msg = raw body))
 *   header    = X-Razorpay-Signature
 *   event id  = x-razorpay-event-id   (unique per event; duplicates by design)
 *
 * Comparison is timing-safe. The secret is NEVER logged (redaction test).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../observability/logger.js';

const log = createLogger('billing:webhook');

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Razorpay subscription event codes (documented set). */
export const SUBSCRIPTION_EVENT_CODES = [
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.completed',
  'subscription.updated',
  'subscription.pending',
  'subscription.halted',
  'subscription.cancelled',
  'subscription.paused',
  'subscription.resumed',
] as const;

export type SubscriptionEventCode = (typeof SUBSCRIPTION_EVENT_CODES)[number];

export interface PaymentProviderEvent {
  /** Provider's unique event id (dedupe key). */
  eventId: string;
  /** Event code, e.g. 'subscription.cancelled'. */
  code: SubscriptionEventCode;
  /** Provider's subscription id (server-authoritative identity). */
  subscriptionId: string;
  /** Provider's tenant/customer reference (mapped to our tenantId). */
  tenantId: string;
  /** Plan the subscription is on (entitlement tier). */
  planId: string;
  /** Provider-side subscription status at event time. */
  providerStatus: string;
  /** Event timestamp (provider-reported; ms epoch). */
  occurredAt: number;
}

/** Verification failure — typed so the route can map to exact HTTP codes. */
export class WebhookVerificationError extends Error {
  constructor(readonly reason: 'invalid-signature' | 'invalid-payload') {
    super(`webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Verify a Razorpay-style webhook: timing-safe HMAC-SHA256 hex comparison
 * of the RAW body against X-Razorpay-Signature. The raw Buffer must be the
 * bytes as received (never re-serialized JSON) per provider docs.
 */
export function verifyRazorpaySignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (signature === undefined || signature.length === 0) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Parse a verified raw body into a PaymentProviderEvent. Strict validation:
 * unknown event codes, missing ids, or non-numeric timestamps are
 * rejected (invalid-payload) rather than half-trusted.
 */
export function parseSubscriptionEvent(rawBody: Buffer): PaymentProviderEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookVerificationError('invalid-payload');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WebhookVerificationError('invalid-payload');
  }
  const obj = parsed as Record<string, unknown>;
  const codeRaw = obj.event ?? obj.type;
  const payloadRaw: unknown = obj.payload ?? {};
  const payload: Record<string, unknown> =
    typeof payloadRaw === 'object' && payloadRaw !== null
      ? (payloadRaw as Record<string, unknown>)
      : {};
  const subscriptionRaw: unknown = payload.subscription ?? payload.entity ?? {};
  const sub: Record<string, unknown> =
    typeof subscriptionRaw === 'object' && subscriptionRaw !== null
      ? (subscriptionRaw as Record<string, unknown>)
      : {};
  const subId = strOrUndef(obj.subscription_id) ?? strOrUndef(sub.id);
  const tenantId = strOrUndef(obj.tenant_id) ?? strOrUndef(sub.tenant_id) ?? strOrUndef(sub.customer_id);
  const planId = strOrUndef(sub.plan_id) ?? strOrUndef(obj.plan_id);
  const providerStatus = strOrUndef(sub.status) ?? 'unknown';
  const occurredRaw = numOrUndef(obj.created_at) ?? numOrUndef(obj.timestamp) ?? Date.now();
  const occurredAt = occurredRaw;

  if (
    typeof subId !== 'string' ||
    subId.length === 0 ||
    typeof tenantId !== 'string' ||
    tenantId.length === 0 ||
    typeof planId !== 'string' ||
    planId.length === 0 ||
    typeof codeRaw !== 'string' ||
    !SUBSCRIPTION_EVENT_CODES.includes(codeRaw as SubscriptionEventCode) ||
    !numOrUndef(occurredRaw)
  ) {
    // Never log the payload itself (data minimization; secret-redaction rule).
    log.warn('webhook payload rejected', { code: typeof codeRaw === 'string' ? codeRaw : 'invalid' });
    throw new WebhookVerificationError('invalid-payload');
  }
  return {
    eventId: strOrUndef(obj.event_id) ?? '',
    code: codeRaw as SubscriptionEventCode,
    subscriptionId: subId,
    tenantId,
    planId,
    providerStatus,
    occurredAt,
  };
}

/** Force an explicit eventId (from the x-razorpay-event-id header). */
export function withEventId(event: PaymentProviderEvent, eventId: string): PaymentProviderEvent {
  return { ...event, eventId };
}
