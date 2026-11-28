# Billing Architecture (M9 — issues #13/#14)

**Status:** implemented and verified 2026-11-27 (Razorpay TEST mode only; no live financial transactions). Restored 2026-11-28 after the baseline replacement removed the original file.

## 1. Modes and the self-hosted boundary

| Mode | Trigger | Behavior |
|---|---|---|
| Self-hosted (default) | `BILLING_ENABLED` unset/false | No billing tables are consulted, no `/api/billing/*` routes, no `/webhooks/razorpay`, no entitlement gate. The MCP server works fully without hosted infrastructure or merchant credentials. |
| Hosted | `BILLING_ENABLED=true` + `DATABASE_URL` + `RAZORPAY_WEBHOOK_SECRET` (config cross-validated, fail-closed at startup) | Billing routes mounted; every metered tool call passes the entitlement gate. |

`BILLING_ENABLED` parsing: explicit boolean parser — case/whitespace variants of `false` stay disabled; anything not exactly `true`/`false` fails configuration startup (fail closed, never silently-on).

## 2. Components

- `src/billing/enforcement.ts` — entitlement + usage gate invoked in `auditedRun` dispatch (`serverFactory.ts`): **fail-closed** on storage errors.
- `src/billing/billingStore.ts` — subscriptions, entitlements, usage counters, webhook events. Quota `take()` uses **insert-claim** (`INSERT … ON CONFLICT DO NOTHING`) on first materialization, then atomic `UPDATE … WHERE used < limit` — concurrent requests cannot oversubscribe.
- `src/billing/webhooks.ts` — HMAC-SHA256 verification over the **raw request bytes** (captured before any parsing), timing-safe compare, `event_id` dedupe, transactional state application.
- `src/mcp/transport/billingApi.ts` — console REST surface (below).
- Admin console Billing tab (`src/mcp/transport/adminPage.ts`) — dashboard, usage meter, plan grid, checkout-pending state, cancellation, all error states; server-side rendering of server data, no client-trusted values.

## 3. Subscription lifecycle

`none → payment-pending (checkout) → active (webhook subscription.authenticated) → canceled (cancel-request + webhook subscription.cancelled) / revoked`. Transitions are **webhook-authoritative only**: `POST /api/billing/checkout` never writes entitlements — it records a pending payment intent. Activation exists solely via a signature-verified provider event. Grace/past-due and recovery states map provider events to the same entitlement gate.

## 4. API surface (hosted mode only)

| Route | Method | Notes |
|---|---|---|
| `/api/billing/summary` | GET | Server-authoritative dashboard payload (subscription, entitlement, usage/limit/exhausted, plan catalog). |
| `/api/billing/checkout` | POST | Test-mode plan selection; returns pending payment state. **Never activates.** |
| `/api/billing/cancel` | POST | Records cancel-request; revocation happens on the verified webhook. |
| `/webhooks/razorpay` | POST | Raw-body HMAC verification, replay-deduped. Mounted only in hosted mode. |

All API routes: authenticated session, session-derived tenant identity (never client-supplied), CSRF double-submit token, audit rows (`billing:checkout-initiated`, `billing:cancel-requested`), rate-limited. Billing-disabled servers 404 the whole surface.

## 5. Pricing and plans

Server-authoritative only. Plan catalog (`BILLING_PLAN_LIMITS`, e.g. `pro`/`team`) is validated configuration; prices come from the server's plan table, never from client input. Checkout requests carry a plan id; the server resolves price and limits.

## 6. Retention decision (6.1)

`webhook_events` rows are **retained indefinitely** (no pruning). They are the replay-protection ledger — deleting them widens the dedup window and lets a captured webhook be replayed after pruning. Volume is tiny (one row per provider event, HMAC + event id only, no payload bodies). The retention sweeper explicitly excludes this class; a structural guard in the sweeper test prevents destructive pruning from being reintroduced.

## 7. Security properties (test-enforced)

Webhook signature forgery rejected; replay (same event id) returns duplicate without re-application; cross-tenant webhook rejected; entitlement enforcement fail-closed on storage error; quota concurrency (Postgres `FOR UPDATE` + SQLite) cannot oversubscribe; checkout cannot self-grant; cancellation requires CSRF + session; audit records carry no token/payload secrets; tenant isolation on every billing query.

## 8. Provider reality

Razorpay integration is **TEST mode**: no live keys in this repository, no real charges. Live keys are a deployment secret (never env-committed). The provider abstraction (`src/billing/provider.ts`) is the seam for a future live provider or a different PSP.
