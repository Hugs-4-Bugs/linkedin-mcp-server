/**
 * M9 issue #13 — subscription lifecycle state machine (server-authoritative).
 *
 * Maps provider subscription events to entitlement status. Idempotent:
 * applying the same event twice, or applying events out of order, converges
 * to the same state. Terminal states are never reopened by later events
 * except an explicit new `authenticated` subscription start.
 *
 * Entitlement statuses (issue #14):
 *   trial | active | past_due | canceled | expired | revoked
 * Grace: past_due carries a grace window (default 7d, ADR-023) — after it
 * elapses, entitlement is expired (revoked). Cancellation/revocation are
 * immediate. No grace on terminal events.
 */
import type { PaymentProviderEvent, SubscriptionEventCode } from './providerEvents.js';

export type EntitlementStatus =
  | 'trial'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'expired'
  | 'revoked';

export interface SubscriptionRecord {
  tenantId: string;
  subscriptionId: string;
  planId: string;
  providerStatus: string;
  entitlementStatus: EntitlementStatus;
  /** Grace deadline (ms epoch) while past_due; null otherwise. */
  graceEndsAt: number | null;
  updatedAt: number;
}

export const GRACE_WINDOW_MS = 7 * 86_400_000;

/** Is the entitlement currently granting paid access? (trial/active/past-due-in-grace) */
export function entitlementUsable(status: EntitlementStatus, now: number, graceEndsAt: number | null): boolean {
  if (status === 'active' || status === 'trial') {
    return true;
  }
  if (status === 'past_due') {
    return graceEndsAt !== null && now < graceEndsAt;
  }
  return false;
}

/**
 * Apply an event to a subscription record (pure function — persistence is
 * the caller's transaction). `current` undefined = subscription not yet seen.
 */
export function applySubscriptionEvent(
  current: SubscriptionRecord | undefined,
  event: PaymentProviderEvent,
  now: number,
): SubscriptionRecord {
  const base: SubscriptionRecord = current ?? {
    tenantId: event.tenantId,
    subscriptionId: event.subscriptionId,
    planId: event.planId,
    providerStatus: event.providerStatus,
    entitlementStatus: 'trial',
    graceEndsAt: null,
    updatedAt: now,
  };
  // Terminal guard: canceled/revoked/expired subscriptions stay closed
  // unless a brand-new authenticated subscription arrives.
  const terminal = base.entitlementStatus === 'canceled' || base.entitlementStatus === 'revoked';
  const code = event.code;
  if (terminal && code !== 'subscription.authenticated') {
    return { ...base, updatedAt: now };
  }
  switch (code) {
    case 'subscription.authenticated':
    case 'subscription.activated':
    case 'subscription.resumed':
    case 'subscription.updated':
      // (re)activation clears any grace window.
      return {
        ...base,
        providerStatus: event.providerStatus,
        planId: event.planId,
        entitlementStatus: 'active',
        graceEndsAt: null,
        updatedAt: now,
      };
    case 'subscription.charged':
      // Successful charge: recovery from past_due if applicable.
      return {
        ...base,
        providerStatus: event.providerStatus,
        entitlementStatus: 'active',
        graceEndsAt: null,
        updatedAt: now,
      };
    case 'subscription.pending':
    case 'subscription.halted':
      // Charge failed / retries exhausted: past_due with grace window.
      return {
        ...base,
        providerStatus: event.providerStatus,
        entitlementStatus: 'past_due',
        graceEndsAt: base.graceEndsAt ?? now + GRACE_WINDOW_MS,
        updatedAt: now,
      };
    case 'subscription.paused':
      return { ...base, providerStatus: event.providerStatus, entitlementStatus: 'past_due', graceEndsAt: now + GRACE_WINDOW_MS, updatedAt: now };
    case 'subscription.cancelled':
      // Immediate revocation — no grace (ADR-023).
      return { ...base, providerStatus: event.providerStatus, entitlementStatus: 'canceled', graceEndsAt: null, updatedAt: now };
    case 'subscription.completed':
      // Natural end of a fixed-cycle subscription.
      return { ...base, providerStatus: event.providerStatus, entitlementStatus: 'expired', graceEndsAt: null, updatedAt: now };
  }
}

/** Evict a past-due entitlement once its grace window has fully elapsed. */
export function resolveExpiredGrace(
  rec: SubscriptionRecord,
  now: number,
): SubscriptionRecord {
  if (rec.entitlementStatus === 'past_due' && rec.graceEndsAt !== null && now >= rec.graceEndsAt) {
    return { ...rec, entitlementStatus: 'expired', graceEndsAt: null, updatedAt: now };
  }
  return rec;
}

/** Event codes that signal an operator-driven immediate revocation. */
export const REVOCATION_EVENT_CODES: readonly SubscriptionEventCode[] = ['subscription.cancelled'];
