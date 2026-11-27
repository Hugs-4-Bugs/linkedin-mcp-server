# M9 Independent Verification Report

**Date:** 2026-11-27 · **Verifier session:** independent pass over the committed state · **Scope:** verification only — no implementation changes were made by this review (per instructions, defects are reported, not silently fixed). M10 not started.

## Phase A — Workspace verification (after another sandbox recycle)

- Checkout had drifted to `main` at a local-only platform snapshot `2cba8d4` (auto-committed scratch scripts, exists on **no** remote branch; `origin/main` is untouched at `85e66838`). Restored `develop` with a plain `git checkout` — no reset, no force, no owner changes overwritten.
- `develop` HEAD = **`b308adc`** (= reported M9 final), parent `d0ef295`. Working tree **clean** (zero tracked modifications, zero untracked inside the repo).
- Lineage `6aabdac` → `b308adc` verified as one unbroken chain: `73dc145` → `8121717` → `d1dd8d9` → `b6d808e` → `d0ef295` → `b308adc` (6 commits, each parent = previous).
- Live remote (`git ls-remote`): `origin/develop` = `6aabdac` (M9 not pushed), `origin/main` = `85e66838` untouched. Deps + dist present.

## Phase B — Adversarial review findings (from committed source, not claims)

### Confirmed defect 1 — `BILLING_ENABLED=false` (string) silently parses as `true`
- **Where:** `src/config/config.ts:71` — `BILLING_ENABLED: z.coerce.boolean().default(false)`.
- **Evidence (executed, not inferred):** zod v4 `coerce.boolean()` applies `Boolean()` JS truthiness — `parseConfig({BILLING_ENABLED:'false'})` returns **`true`**. Reproduced against the compiled dist: `parseConfig({ENVIRONMENT:'local', BILLING_ENABLED:'false', DATABASE_URL:'sqlite:x', RAZORPAY_WEBHOOK_SECRET:'…'}) → BILLING_ENABLED === true`.
- **Impact:** an operator who explicitly writes `BILLING_ENABLED=false` on a hosted deploy (DATABASE_URL + secret present) gets billing **silently enabled**: webhook route mounted, entitlement gates active on all 8 metered tools — the opposite of their explicit instruction. Without the other two vars, startup instead throws a misleading ConfigError ("billing requires…") for someone who *disabled* billing.
- **Not triggered by tests:** the e2e only ever sets `'true'` or unset; default-false is tested but the `='false'` string is not.
- **Minimal proposed correction (issue-scoped):** parse the env string explicitly, e.g. `z.string().transform(v => v.trim().toLowerCase() === 'true')` with `default('false')`, or a small preprocess on `['true','1','yes']`. One-line change + 3 test cases.

### Confirmed defect 2 — quota race on first counter materialization (`FOR UPDATE` cannot lock a nonexistent row)
- **Where:** `src/billing/billingStore.ts:198-239` (`SqlBillingStore.take`) and identically `src/auth/linkedin/sqlPublishStores.ts` (`SqlPublishBudget.take`, M5-era).
- **Mechanism:** when the tenant's `usage_counters`/`publish_budgets` row does **not** exist yet, `SELECT … FOR UPDATE` finds nothing to lock; N concurrent first-time takes each observe an empty hits list, each `INSERT … ON CONFLICT DO UPDATE` (last-write-wins), and **each returns `true`** — quota capacity is exceeded.
- **Evidence (executed reproduction, fresh embedded PG 19):** 14 concurrent `take()` vs capacity 5: **18/20 rounds over-consumed** (observed 6–13 allowed, e.g. `ALLOWED 9 > capacity 5`). The same probe on `SqlPublishBudget` reproduces it, and the identical probe on the **pure M8 baseline commit `6aabdac`** (isolated worktree) reproduces it at **8/10 rounds** — i.e. the race **pre-exists M9** in the M5 publish-budget pattern that M9 deliberately reused, and the M9 test suite's single occasional flake (`pg-billing-integration … concurrent take() never exceeds capacity: expected 7 to be 5`) is exactly this defect surfacing (~1-in-25 full-suite runs in this sandbox).
- **Security framing:** issue #14 requires "atomic quota consumption / concurrent requests cannot bypass". The window is the first N concurrent calls for a tenant/counter whose row is absent; steady-state (row exists) locking is correct. Over-consumption is bounded (~pool width per materialization event), but it is a real correctness defect in the entitlement quota, and it also affects the M5 publish budget.
- **Minimal proposed correction (issue-scoped):** make materialization itself atomic — e.g. `INSERT … ON CONFLICT DO NOTHING` the row *inside* the transaction first, then `SELECT … FOR UPDATE` (the row now exists and is locked), or `INSERT … ON CONFLICT DO UPDATE SET hits = (SELECT …) … WHERE` guard. Apply to both `SqlBillingStore.take` and `SqlPublishBudget.take` (the latter arguably an M5 bug, owner should decide whether it lands inside this milestone's correction).

### Risk requiring clarification — billing tables are not in the retention sweeper
- `src/storage/retention.ts` sweeps sessions, api_tokens, oauth_states, publish_operations, audit_log, publish_budgets — **not** `webhook_events`/`subscriptions`/`entitlements`/`usage_counters`. `webhook_events` grows unboundedly with every (deduped) provider event. Not a correctness defect for #13/#14 as written; flagged for the owner as an operational gap for hosted mode.

### Verified correct (evidence: source lines cited above + test matrix re-run in Phase C)
1. **Raw-body signature verification** — `webhookRoute.processWebhook` HMACs the exact received Buffer; http-entry accumulates chunks before any JSON parse; re-serialization signature-break test passes.
2. **Signature comparison / malformed handling / secret exposure** — `providerEvents.ts:75-90`: length check then `timingSafeEqual`; malformed/missing signature → boolean false → 400; secret never logged (grep: only HMAC-key usage; redaction test asserts secret absent from log output).
3. **Replay protection / event-ID uniqueness** — SQL: unique `webhook_events.event_id` + `ON CONFLICT DO NOTHING` inside the apply transaction (billingStore.ts:125-132); duplicate → no state change (tests: replay, fresh-sig-same-id).
4. **Duplicate processing / transaction boundaries** — dedupe claim, subscription upsert, entitlement upsert all inside one `exec.with()`; forced-rollback test on real PG shows zero rows persist.
5. **Out-of-order / stale events** — state machine is order-independent and converges (cancel-before-auth test); terminal states not reopened except `authenticated`. `occurredAt` is parsed but not used to reject late events — acceptable for subscription state (Razorpay guidance: handle by id, order not guaranteed), consistent with design.
6. **Lifecycle transitions & recovery** — all 10 codes mapped; `charged`/`activated`/`resumed` recover from `past_due` clearing grace; per-code tests.
7. **Cancellation / expiry / revocation** — `cancelled` → immediate `canceled` (no grace); `completed` → `expired`; grace lapse resolves to `expired` at read time; tests for each.
8. **Grace semantics** — 7d window on `pending`/`halted` (first grace timestamp is *kept*, not extended by repeated failure events — correct anti-extension behavior); `paused` re-arms a fresh window; usable strictly `now < graceEndsAt`.
9. **Tenant isolation** — every SQL billing query is `WHERE tenant_id = $1` (4 sites verified); gate tenant comes only from ALS `currentTenant()`; cross-tenant entitlement + quota tests.
10. **Protected dispatch paths** — all 8 side-effecting/LinkedIn tools gated (`connect`, `status`, `disconnect`, `get_my_profile`, `list_granted_scopes`, `draft`, `preview`, `publish` — serverFactory.ts:356-459). The MCP `status` tool is intentionally ungated: it is read-only, makes no LinkedIn call, and gates nothing (harmless either way; noted for completeness). Billing refusals surface as structured `isError` results, never raw stacks.
11. **Quota enforcement / concurrency** — see defect 2 (steady-state correct: 14-vs-5 exactly 5 when the row pre-exists; enforcement gate rejects the 4th call at plan capacity 3 on real PG).
12. **Cache invalidation / stale windows** — TTL 60s + `invalidate('*')` called by http-entry on every applied webhook; immediate-revocation test and TTL-expiry self-heal test both pass. Note: `BILLING_CACHE_TTL_SECONDS` config exists but the TTL is hardcoded 60_000 in enforcement.ts — cosmetic config-not-wired gap (defaults identical; not a defect, listed for the record).
13. **Fail-closed unknown plans** — `capacity ?? 0` → EntitlementRequiredError (test: unmapped plan rejects, never silent-unlimited).
14. **Webhook rate limiting / DoS** — route sits behind the same per-IP `HTTP_RATE_LIMIT_PER_MINUTE` limiter and `MAX_BODY_MIB` cap with destroy-on-overflow (413) *before* buffering; signature verified before any parse beyond size check. Adequate for first hosted deployment; noted as fine.
15. **Audit logging / sensitive data** — webhook audit rows: action=`billing:webhook:<code>`, detail `applied|duplicate` only; audit failure never changes webhook outcome; no payload/sub_id in audit (test asserts).
16. **Self-hosted with BILLING_ENABLED unset** — `parseConfig({ENVIRONMENT:'local'}) → BILLING_ENABLED === false` (verified on dist); `buildBilling` returns `undefined` objects; `withBillingGate` returns the bare fn; route 404s; MCP fully works with zero billing env (e2e test with real server).
17. **Partial config startup failures** — both fail-closed rules throw `ConfigError` (verified on dist: no-DATABASE_URL and no-secret cases).
18. **Migrations both dialects** — migration 2 present in `postgres` and `sqlite` arrays (4 tables + 3 indexes each); PG integration asserts tables materialize + re-run idempotent; SQLite covered via e2e + unit stores.
19. **Restart / persistence** — real-PG restart test: server stop/start; entitlement, usage counter, and dedupe set all survive; duplicate event still `duplicate`.
20. **Dependency / secret / security scans** — `npm audit` 0 and `--omit=dev` 0; secret-scan script clean; per-commit secret grep 0; **zero dependency changes** (lockfile untouched across `6aabdac..b308adc`).

## Phase C — Verification pipeline (from committed `b308adc`; actual outputs)

| Check | Result | Exit code |
|---|---|---|
| Full test suite (`npx vitest run`) | **28 files / 330 tests passed** in the overwhelming majority of runs (25+ runs: 24 green, 1 red — the failure is exactly defect 2's race in `pg-billing-integration > concurrent take() never exceeds capacity`, `expected 7 to be 5`) | 0 (green runs) |
| Real PG suites (pg-integration + pg-billing-integration) | **26/26 passed**, ×5 consecutive repeats | 0 each |
| HTTP webhook E2E | **6/6 passed** (signed 200, invalid-sig 400, replay duplicate, tampered-body 400, self-host route 404, self-host MCP 200) | 0 |
| Typecheck (`npm run typecheck`) | 0 errors | 0 |
| Lint (`npx eslint .`) | 0 errors, 0 warnings | 0 |
| Build (`npm run build`) | dist rebuilt | 0 |
| `npm audit` / `--omit=dev` | 0 / 0 vulnerabilities | 0 |
| Secret scan (`scripts/secret-scan.sh`) | clean | 0 |
| Diff/commit review | 19 files, +2,432/−17 across 6 commits; all files are M9-scoped (billing src/tests/docs/memory) — no out-of-scope file touched | — |

## Phase D — Remote synchronization: NOT performed (authentication unavailable)

Live-verified this session: no `credential.helper` configured, no `~/.git-credentials`/`~/.netrc`, no `GH_TOKEN`/`GITHUB_TOKEN` in env; `git push --dry-run origin develop` → `fatal: could not read Username for 'https://github.com'`; GitHub API returns 403 (unauthenticated rate limit exhausted: 0/60, resets 07:34 UTC today). **The push was NOT attempted as a claim — it is impossible from this environment. No force, no main, no merge occurred.**

**Exact owner-side commands (verified state: local `develop` = `b308adc`, origin/develop = `6aabdac`, pure fast-forward):**
```bash
git checkout develop
git push origin develop        # fast-forward 6aabdac..b308adc, no force needed
```

## Phase E — PR: not created (same auth limitation)

No GitHub token available → no PR creation, none claimed. Verified steps once authenticated (do not merge):
```bash
git checkout -b m9-billing b308adc && git push origin m9-billing
gh pr create --base develop --head m9-billing \
  --title "M9: payment verification, webhook security, hosted entitlements (Refs #13, Refs #14)" \
  --body "Refs #13, Refs #14 — 6 commits 73dc145..b308adc; 330/330 tests; real-PG integration; audit 0; scan clean; zero dependency changes. Includes independent verification report (2 defects found + reported, see M9_VERIFICATION_REPORT.md)."
```

## Phase F — Summary

- **Baseline SHA:** `6aabdac` (M8 final, = origin/develop). **Final SHA:** `b308adc` (local develop; not pushed).
- **Confirmed defects: 2** — (1) `BILLING_ENABLED='false'` string coerces true (M9 config, silent-enable footgun); (2) first-materialization quota race in `SqlBillingStore.take` (pattern inherited from M5 `SqlPublishBudget.take`; reproduced 18/20 rounds; **pre-exists M9**, also the cause of the ~1-in-25 suite flake). **Neither was fixed in this pass** — per instructions they are reported with minimal issue-scoped corrections for owner decision.
- **Risk flagged: 1** — billing tables absent from retention sweeper (unbounded `webhook_events` growth in hosted mode).
- **Everything else (17 of 20 review areas) verified correct with cited evidence;** full pipeline green; self-hosting boundary proven end-to-end.
- **Owner actions:** decide on the two defect fixes (recommend both; #2 touches M5 code as well); push `develop`; optionally open the PR; then gate M10.
- **Production-only limitations (unchanged):** no live Razorpay validation performed or claimed (test-mode fixtures + provider-doc-verified scheme only); no merchant credentials; no public deploy; plan catalog/checkout surface owner-side.
