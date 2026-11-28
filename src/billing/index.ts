/**
 * M9 — billing index: what the rest of the app imports from `../billing/`.
 */
export {
  SUBSCRIPTION_EVENT_CODES,
  WebhookVerificationError,
  parseSubscriptionEvent,
  verifyRazorpaySignature,
  withEventId,
  type PaymentProviderEvent,
  type SubscriptionEventCode,
} from './providerEvents.js';
export {
  GRACE_WINDOW_MS,
  applySubscriptionEvent,
  entitlementUsable,
  resolveExpiredGrace,
  type EntitlementStatus,
  type SubscriptionRecord,
} from './subscriptionStateMachine.js';
export {
  InMemoryBillingStore,
  SqlBillingStore,
  type ApplyOutcome,
  type BillingStore,
  type UsageSnapshot,
} from './billingStore.js';
export {
  BillingEnforcement,
  DisabledBillingEnforcement,
  EntitlementRequiredError,
  UsageLimitExceededError,
  isBillingEnabled,
  type AnyBillingEnforcement,
  type BillingEnforcementOptions,
} from './enforcement.js';
export {
  processWebhook,
  signRazorpayBody,
  webhookStatusFor,
  type BillingAudit,
  type WebhookResult,
  type WebhookRouteOptions,
} from './webhookRoute.js';
