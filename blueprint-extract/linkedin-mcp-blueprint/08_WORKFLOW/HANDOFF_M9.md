# Milestone 9 Handoff Report — Hosted SaaS & Monetization (Issues #13/#14)

**Date:** 2026-11-27 · **Status:** COMPLETE, all gates green · **Branch:** `develop` · **Boundary:** stopped at M9; M10 not started.

## 1. Baseline verification (Phase 0)

Sandbox recycled again (checkout found on `main`@M4-era); local `develop` ref survived at `6aabdac`. Restored, deps reinstalled (`npm ci`), dist rebuilt. Verified: HEAD `6aabdac` = reported M8 final = live `origin/develop` (via `git ls-remote`); remote `main` = `85e66838…` untouched; tree clean; **278/278 re-run green + secret scan clean BEFORE any M9 work**.

## 2–3. Verified issue contents + milestone mapping (Phase 1, live GitHub)

GitHub API was rate-limited from this IP this session; verified via the GitHub web pages:
- **#13 "Payment provider verification and webhook security"** — open, milestone **M9 — Hosted SaaS & Monetization**, labels `type: security / priority: high / area: billing`, no assignee. Body: *"Future: server-side payment verification, signature validation, replay protection, subscription lifecycle and entitlement revocation."*
- **#14 "Hosted entitlement enforcement design"** — open, M9, `type: feature / priority: medium / area: billing`, no assignee. Body: *"Design server-side hosted entitlements and usage limits. Self-hosting must not require hosted payment."*
- M9 milestone (#6) = exactly these two issues; description *"Paid entitlements, subscriptions, server-side verification, metering and anti-bypass controls; future scope."* The task message authorizes M9 — this satisfied the owner-approval gate recorded in HANDOFF_M8 §13/§14 and `memory/NEXT_ACTIONS.md`. No issue state/labels/milestone changed by this work.

## 4. Provider decision (Phase 3 — ADR-024, reasoning + sources)

**Razorpay, test mode only, behind a provider-agnostic event contract.**
- India-based merchant eligibility: native (the repo's India context); **Stripe India is "Preview" only** (verified against stripe.com/global — an Indian entity cannot yet register as a standard Stripe merchant; Atlas workaround only).
- Webhook security model (verified against Razorpay docs): HMAC-SHA256 over the **raw request body** with the dashboard webhook secret, hex digest in `X-Razorpay-Signature`; **`x-razorpay-event-id` unique per event** (duplicates by design, order NOT guaranteed).
- Subscription lifecycle: 10 documented `subscription.*` event codes (authenticated, activated, charged, completed, updated, pending, halted, cancelled, paused, resumed) and states (active/pending/halted/cancelled/completed) — all mapped 1:1 into the state machine.
- Sandbox: full Test mode replica + test cards.
- No SDK dependency added: verification is plain `node:crypto` HMAC (the provider-agnostic `PaymentProviderEvent` leaves a second provider possible without rework).
- Constraints honored: **test mode only; no merchant credentials configured; no live charges; no public deployment** (non-negotiables 12–15).

## 5–8. Architecture / webhook security / lifecycle / entitlement model

Full design record: `02_ARCHITECTURE/BILLING_ARCHITECTURE.md` (ADR-023 + ADR-024). Summary:
- **Reuse, not rebuild:** new tables ride the existing `SqlExecutor` (parameterized SQL, `with()` transactions, `FOR UPDATE`), the audit goes through the existing `audit_log`, quota atomicity copies the proven `SqlPublishBudget.take` pattern, tenant identity comes only from the authenticated ALS context (`currentTenant()`), and billing gates tool dispatch exactly where `authorize()` already runs.
- **Webhook security (issue #13):** timing-safe HMAC over raw bytes (captured before any JSON parse), event-id dedupe via unique constraint + `ON CONFLICT DO NOTHING`, strict payload validation, single-transaction apply (claim + subscription upsert + entitlement update) so a crash can never half-apply, audit rows without payloads, secret never logged (test-enforced).
- **Subscription lifecycle (issue #13):** server-authoritative state machine; terminal states never reopen; `pending/halted` → `past_due` with a 7-day grace (ADR-023 rationale: retry exhaustion is pre-cancellation); `cancelled` → immediate revocation, no grace; `completed` → expired; recovery via charged/activated; out-of-order events converge.
- **Entitlements (issue #14):** `entitlements` + `usage_counters` per tenant; enforcement = entitlement check + atomic quota take; TTL cache (60s bounded) with `invalidate(*)` on every webhook apply; unmapped plans fail closed; concurrent take() proven atomic on real PG.
- **Self-hosting (issue #14 hard constraint):** `BILLING_ENABLED` **default false**; billing activates only with persistence + webhook secret (fail-closed config rules reject partial enablement at startup); disabled mode = no billing objects at all (pure-allow gate, no store access, no tables, no routes — probes get 404); enforcement reads only local SQL, never the provider, so provider outages cannot affect access decisions.

## 9–10. Usage enforcement + tenant isolation

Metered per-tool-call quota by plan (`BILLING_PLAN_LIMITS`), consumed atomically inside a `FOR UPDATE` transaction (Postgres; SQLite serializes writers). Entitlement + usage rows are tenant-keyed; the gate uses the authenticated tenant only — cross-tenant tests confirm isolation (entitlement leakage + quota cross-consumption both rejected).

## 11. Files changed (15 files, +2,307/−13)

- New: `src/billing/{providerEvents,subscriptionStateMachine,billingStore,enforcement,webhookRoute,index}.ts`, `02_ARCHITECTURE/BILLING_ARCHITECTURE.md`, `tests/security/{billing-security,entitlement-enforcement}.test.ts`, `tests/integration/{pg-billing-integration,billing-webhook-e2e}.test.ts`
- Modified: `src/config/config.ts` (4 billing fields + fail-closed rules), `src/storage/migrations.ts` (migration 2: 4 tables, both dialects), `src/mcp/serverFactory.ts` (runtime + `withBillingGate`), `src/mcp/transport/http-entry.ts` (`/webhooks/razorpay` route)

## 12–14. Tests: 278 → 330 (52 new, 0 failures, 0 skipped)

20 webhook security · 17 entitlement enforcement · 9 real-PG billing · 6 HTTP webhook e2e. Nothing weakened/removed/skipped; the only pre-existing test change is zero.

## 15. PostgreSQL (real, not SQLite-only)

`tests/integration/pg-billing-integration.test.ts` — embedded PG 19 (real initdb/server/wire protocol): migrations materialize + idempotent, unique-event-id dedupe on PG, tenant isolation in SQL, cancel revocation, **14 concurrent take() vs capacity 5 — exactly 5 allowed (FOR UPDATE)**, forced rollback leaves zero rows, **restart survival** (server stop/start; entitlement, usage and dedupe set persist).

## 16–19. Typecheck / lint / build / audit

`tsc --noEmit` 0 errors · `eslint .` 0 errors 0 warnings · `npm run build` 0 · `npm audit` and `npm audit --omit=dev` **0 vulnerabilities** · `bash scripts/secret-scan.sh` clean (also per-commit grep of all 5 commits: 0 secret-pattern hits).

## 20. Dependency changes

**None.** Zero packages added/upgraded (HMAC via `node:crypto`; tests use the existing embedded-postgres dev-dep). Lockfile unchanged.

## 21–23. Commits (lineage + tree state)

| Batch | SHA | Parent | Scope |
|---|---|---|---|
| 1 | `73dc1457dc110dfc6dfbc4c60557b86dd20460b1` | `6aabdac` (M8) | billing core (events/state machine/stores/config/migration) — Refs #13 |
| 2 | `81217175165b4942e69d6ea821bf18b2ad380d02` | `73dc145` | entitlement enforcement wiring — Refs #14 |
| 3 | `d1dd8d97e2c0a4f0bc7f92c7cf007cf603c66cea` | `8121717` | /webhooks/razorpay HTTP route — Refs #13 |
| 4 | `b6d808efb4c0b3eb7a47e02262192a8db4469cda` | `d1dd8d9` | 52 tests — Refs #13, Refs #14 |
| 5 | `d0ef2957248d173a41689371a90b9956041e0148` | `b6d808e` | BILLING_ARCHITECTURE.md (ADR-023/024) — Refs #13, Refs #14 |

Each commit verified after the fact: SHA, parent lineage, tree stats, file list, secret grep (0), working tree clean.

## 24. Remote develop SHA

**NOT pushed this session — see §26.** Local `develop` = `d0ef295` (+ documentation commit to follow). `origin/develop` remains `6aabdac` (verified via `ls-remote`). Remote `main` = `85e66838…` untouched.

## 25. Working tree

Clean apart from this handoff + memory updates (committed in the final documentation batch).

## 26. PR links / push status — the exact limitation

- **No PR was created** (and none is claimed): the GitHub PAT used in M6–M8 sessions is **not present in this session's environment**, so there is no API token for PR creation and `git push` fails with `fatal: could not read Username for 'https://github.com': terminal prompts disabled` (transport credentials absent). Verified live: `git ls-remote` still works (read-only anonymous), API returns 401 for bad tokens.
- **Owner push steps (the commits are complete and verified on local `develop`):**
  1. Provide a Contents:write PAT (or run from an authenticated environment) and `git push origin develop` (fast-forward `6aabdac..HEAD`, no force).
  2. Optional PR record: `git checkout -b m9-billing d0ef295 && git push origin m9-billing`, then open PR `m9-billing` → `develop`, body: "Refs #13, Refs #14 — 5 commits 73dc145..d0ef295; 330/330 tests; PG integration green; audit 0; scan clean; zero dependency changes."
  3. Note: even with the M6–M8 PAT, PR creation returned 403 (Contents:write-only) — expect PR API writes to need a token with Issues/Pulls scope.

## 27. Limitations (what remains unverified)

- **No live Razorpay integration was performed or is claimed**: no merchant account, no real webhook secret, no test-mode dashboard webhook. All signature/event/lifecycle evidence is deterministic fixtures + the provider's documented scheme (HMAC-SHA256 raw body, headers, 10 event codes, states) fetched from razorpay.com docs during this session. First live-mode validation belongs to the owner's staging bring-up.
- Checkout/session UI, plan catalog surface (pricing page), and hosted tenant→Razorpay-customer mapping via API are out of the #13/#14 text and were not built (the issue scope is verification + enforcement, which is complete).
- Rate limiting on the webhook route reuses the per-IP limiter (adequate for a first hosted deployment; a dedicated webhook budget can be added with usage data).

## 28. Owner actions

1. Review the 5 commits on `develop`; push when satisfied (§26 steps).
2. Staging bring-up: set `BILLING_ENABLED=true`, `DATABASE_URL`, `RAZORPAY_WEBHOOK_SECRET` (Razorpay **test mode**) — the fail-closed config rules will reject partial enablement.
3. Configure the Razorpay test-mode webhook to `POST /webhooks/razorpay` and validate the first real signed delivery.
4. Decide plan catalog + limits (`BILLING_PLAN_LIMITS`) and the checkout flow owner-side before public monetization (D-A6/D-A7 gates remain).
5. Approve M10 (Scale & Operations) before any further milestone work.

## 29. Completion recommendation

**M9 is technically complete for issues #13 and #14.** Every requirement in both issue bodies is implemented and test-enforced: server-side payment verification (signature validation, replay protection, idempotency), subscription lifecycle with entitlement revocation (issue #13); server-side hosted entitlements and usage limits with self-hosting requiring no hosted payment (issue #14) — the self-host boundary is proven by a dedicated e2e (route 404 + MCP fully functional with zero billing env). 330/330 tests (278 baseline preserved + 52 new), real-PG evidence, audit 0, scan clean, zero dependency changes. Remaining items are owner-side operational decisions (§28), not implementation gaps.
