# M9 Billing Architecture (issues #13/#14)

**Status:** implemented 2026-11-27 · **Branch:** `develop` · **Scope gates:** Refs #13, Refs #14

This document is the Phase-2/Phase-3 design record required before
implementation. It covers the payment provider decision (ADR-024), the
billing/entitlement architecture (ADR-023), and the self-hosting boundary.

## 1. Verified issue scope (live GitHub, 2026-11-27)

- **#13 "Payment provider verification and webhook security"** (open, M9,
  `type: security / priority: high / area: billing`): "Future: server-side
  payment verification, signature validation, replay protection, subscription
  lifecycle and entitlement revocation."
- **#14 "Hosted entitlement enforcement design"** (open, M9, `type: feature /
  priority: medium / area: billing`): "Design server-side hosted
  entitlements and usage limits. Self-hosting must not require hosted payment."
- Milestone M9 (#6) description: "Paid entitlements, subscriptions,
  server-side verification, metering and anti-bypass controls; future scope."
  Contains exactly these two issues. Owner authorization to begin: given.

## 2. ADR-023 — Billing & entitlement architecture

**Decision.** Billing is an *optional hosted subsystem* layered on the
existing seams, not a parallel architecture:

- **Persistence:** new SQL tables `webhook_events`, `subscriptions`,
  `entitlements`, `usage_counters` — same `SqlExecutor` (parameterized SQL,
  explicit `with()` transactions, `FOR UPDATE` row locks on Postgres), same
  migration list, same in-memory↔SQL duality as M5 (`publish_budgets` is the
  template). No ORM, no new dependency.
- **Authorization path:** enforcement gates the *existing* tool dispatch:
  `buildRuntime`/`buildPersistentRuntime` attach an optional
  `BillingEnforcement` to the runtime; `serverFactory` wraps tool execution
  exactly where `authorize()` already runs. Tenant identity comes ONLY from
  the authenticated ALS context (`currentTenant()`), never from tool
  arguments — same non-bypassable path as tenant isolation (ADR-019).
- **Audit:** billing actions write through the existing `audit_log`
  (`actor='billing'`, action codes, never payloads) — the M7 audit trail.
- **Usage accounting:** atomic quota consumption reuses the
  `SqlPublishBudget` pattern: read-modify-write inside a transaction with
  `SELECT … FOR UPDATE` (Postgres) — already proven under concurrent
  take() by `pg-integration.test.ts`.
- **Entitlement model:** one `entitlements` row per (tenant, plan) with
  `status ∈ {trial, active, past_due, canceled, expired, revoked}` derived
  from the subscription state machine; a small in-process TTL cache with
  invalidation on every webhook transition (cache TTL 60s, purge on write —
  a stale cache can never extend, only briefly delay, a revocation).
- **Grace:** a subscription reaching `halted` (Razorpay's exhausted-retries
  state) maps to `past_due` with a 7-day grace window; after grace →
  `expired`. Rationale: charge-retry exhaustion is Razorpay's *pre-cancellation*
  state and a short grace period avoids hard-revoking tenants mid-retry.
  Cancellation/revocation are immediate — no grace.
- **Provider outage behavior:** webhooks that fail verification are
  rejected (400) and never mutate state; a provider API outage affects
  only new subscription creation (checkout start), never enforcement of
  already-persisted entitlements (enforcement reads local SQL, not the
  provider).

## 3. ADR-024 — Payment provider: Razorpay (test mode only)

**Decision.** Razorpay, integrated in **test mode only**, behind a
provider-agnostic event interface.

**Reasoning (Phase 3 evaluation, sources cited in HANDOFF_M9):**

| Criterion | Razorpay | Stripe |
|---|---|---|
| India-based merchant eligibility | Native (India-first gateway) | **Preview only** — not a standard supported country; "Contact sales" (stripe.com/global, verified) |
| SaaS subscriptions | Subscriptions API with plans/charge schedules | Full Billing product |
| Webhook security | HMAC-SHA256 over raw body, `X-Razorpay-Signature` (hex); timing-safe compare is our responsibility | HMAC-SHA256 with timestamp+scheme (Stripe-Signature) |
| Replay/dedup | `x-razorpay-event-id` unique per event; duplicates by design; order NOT guaranteed | `id` per event; order not guaranteed |
| Subscription lifecycle events | 10 `subscription.*` event codes (authenticated/activated/charged/completed/updated/pending/halted/cancelled/paused/resumed) | `customer.subscription.*` events |
| Sandbox | Test mode = full replica; test cards for Indian payments; test webhooks | Test mode |
| India cost structure | ~2–3% domestic; UPI native | ~3.9%+₹7 international-style fees (higher for INR) |

Razorpay wins for this repo's India-based owner context (Hugs-4-Bugs,
India-focused evaluation criteria in the M9 prompt) on merchant eligibility
and India payments; Stripe remains a possible future second region via the
provider-agnostic event shape (`PaymentProviderEvent`), which deliberately
mirrors Razorpay's event codes but is not coupled to its SDK (no SDK
dependency is added — verification is plain `node:crypto` HMAC).

**Constraints honored:** test mode only; no merchant credentials, no live
charges, no public deployment (non-negotiables #12–#15). The webhook secret
arrives via config (`RAZORPAY_WEBHOOK_SECRET`) — in tests, deterministic
fixtures; never logged (redaction test enforced).

## 4. Architecture boundaries

```
                 ┌─ hosted deployment (ENVIRONMENT=production/staging, DATABASE_URL set)
http-entry ────► /webhooks/razorpay (NEW route: raw-body capture BEFORE JSON parse)
                 │   verifyHmac(rawBody, secret, X-Razorpay-Signature)  [timing-safe]
                 │   dedupe on x-razorpay-event-id (INSERT ... ON CONFLICT DO NOTHING)
                 │   → billing.applyEvent(event)  [single transaction]
                 │       webhook_events row + subscription state transition
                 │       entitlement status update + cache purge + audit row
                 └─ 200 {received} | 400 {invalid-signature|duplicate} | 500 (never 2xx on failure)

tool call ────► authorize() [existing] ─► billing gate [NEW: entitlement check + usage take()]
                                             │ SQL entitlements row (tenant-scoped)
                                             │ usage_counters atomic take() (FOR UPDATE)
                                             └─ fail-closed only when BILLING is ENABLED

self-hosted (local / no billing config) ──► BillingEnforcement = 'disabled'
             · no billing routes mounted, no tables required, no provider calls
             · zero behavior change from M8 — enforced by tests
```

**Self-hosting protection (issue #14 hard constraint):** billing activates
only when `BILLING_ENABLED=true` **and** `DATABASE_URL` is set (hosted
persistence). Any other combination = disabled enforcement: no entitlement
checks, no quota tables touched, no webhook route, no provider connectivity.
`BILLING_ENABLED=true` without `RAZORPAY_WEBHOOK_SECRET` fails fast at
startup (fail-closed config rule).

## 5. Subscription state machine (server-authoritative)

States map 1:1 from Razorpay's documented codes; transitions are applied
idempotently inside the same transaction that persists the event:

```
(none) ──authenticated/activated──► active ──paused──► paused ──resumed──► active
active ──charged──► active (charge recorded; window extended)
any ──cancelled──► canceled   (terminal; entitlement → revoked immediately)
any ──completed──► completed  (terminal; entitlement → expired at period end)
active ──pending──► past_due (grace window starts)
past_due ──halted──► past_due (retry exhaustion; grace countdown continues)
past_due ──charged/activated──► active (recovery)
past_due ──expiry(now > grace_end)──► expired (revoked)
```

Rules: later webhooks never reopen terminal states (`canceled`, `completed`
absent a new `authenticated` event); every transition writes an audit row;
event application is a single transaction (event row insert + subscription
upsert + entitlement update) so a crash mid-webhook can never persist a
half-applied transition.

## 6. Threat coverage (issue #13 "type: security")

| Threat | Control | Test |
|---|---|---|
| Forged webhook | HMAC-SHA256 timing-safe verify over RAW body | invalid-signature 400 |
| Replay | unique event-id dedupe (DB constraint + ON CONFLICT) | replay → duplicate, no double-apply |
| Duplicate delivery | same dedupe path | duplicate event idempotent |
| Out-of-order events | state machine order-independent rules | order-swapped application |
| Secret leak via logs | redaction in billing logger | secret never in log output |
| Client-claimed status | entitlement read from SQL only; tools never accept status args | gate rejects fabricated context |
| Cross-tenant entitlement | entitlement rows keyed by tenantId; gate uses authenticated ALS tenant | cross-tenant rejection test |
| Quota race under concurrency | FOR UPDATE atomic take() | concurrent take() ≤ capacity |
| Crash mid-webhook | single-transaction apply | restart-survival test |
| Provider outage | enforcement never calls provider | no-network test |

## 7. Files (implementation map)

- `src/billing/providerEvents.ts` — provider-agnostic event contract + Razorpay HMAC verification (issue #13)
- `src/billing/subscriptionStateMachine.ts` — transitions + entitlement mapping (issue #13)
- `src/billing/billingStore.ts` — SQL + in-memory stores: webhook events, subscriptions, entitlements, usage counters (issues #13/#14)
- `src/billing/enforcement.ts` — `BillingEnforcement` gate + TTL cache (issue #14)
- `src/billing/webhookRoute.ts` — HTTP route, raw-body capture, rate-limit reuse (issue #13)
- `src/config/config.ts` — `BILLING_ENABLED`, `RAZORPAY_WEBHOOK_SECRET`, hosted-tier limits (self-host gate)
- `src/storage/migrations.ts` — 4 new tables (PG + SQLite variants)
- `src/mcp/serverFactory.ts` — runtime wiring: gate into tool dispatch, billing route mounted only when enabled
- `tests/security/billing-security.test.ts` — issue #13 matrix
- `tests/security/entitlement-enforcement.test.ts` — issue #14 matrix
- `tests/integration/pg-billing-integration.test.ts` — real-PostgreSQL persistence/concurrency/restart
