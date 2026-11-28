# Requirements-to-Implementation Matrix (audit deliverable, step 5)

**Audit basis:** repository state at baseline `07e6a1c` + this session's implementation batches. Every claim below was verified against actual code and tests (not READMEs). Status vocabulary per the master assignment.

| # | Requirement | Source documentation | Implementation location | Status | Test coverage | Security implications | API/Infra dependency | Remaining gap | Priority |
|---|---|---|---|---|---|---|---|---|---|
| 1 | MCP server skeleton, stdio + Streamable HTTP | MCP_PROTOCOL_DESIGN.md | src/mcp/transport/stdio-entry.ts, http-entry.ts | IMPLEMENTED AND VERIFIED | stdio-e2e, http-e2e, client-compat-chatgpt/claude | body caps, headers, timeouts | none | none | — |
| 2 | OAuth 3LO connection lifecycle, vault, CSRF states | AUTHENTICATION_ARCHITECTURE.md | src/auth/linkedin/* | IMPLEMENTED AND VERIFIED | oauth-flow-e2e, oauth-hygiene | AES-GCM vault, state CSRF | LinkedIn app approval (live creds) | live LinkedIn validation is owner-side | external |
| 3 | Profile + scope transparency (get_my_profile, granted scopes) | PRODUCT_REQUIREMENTS.md | src/tools/profileTools.ts | IMPLEMENTED AND VERIFIED | profile-flow-e2e, userinfo-and-scopes | strict allowlist, 401/timeout | OIDC userinfo endpoint | live validation owner-side | external |
| 4 | Publishing with write safety (confirm gate, duplicate window, daily budget, no auto-retry) | FEATURE_SCOPE.md, ADR-015/016/017 | src/tools/publishTools.ts | IMPLEMENTED AND VERIFIED | publish-flow-e2e, publish-security | fingerprint dedupe, idempotency ledger | LinkedIn Posts API + w_member_social | live publishing blocked on owner LinkedIn credentials | external |
| 5 | Persistence, migrations, tenant isolation | STORAGE_DESIGN.md | src/storage/* | IMPLEMENTED AND VERIFIED | db-persistence, pg-integration (20), pg-billing-integration (10) | tenant_id on every table/query | Postgres in production | none | — |
| 6 | Retention sweeps + data privacy | DATA_PRIVACY.md | src/storage/retention.ts | IMPLEMENTED AND VERIFIED | retention (9 tests) | TTL per class; webhook_events deliberately retained | none | none | — |
| 7 | Billing: provider abstraction, webhook HMAC, replay dedupe, transactional state machine | BILLING_ARCHITECTURE.md (restored this session) | src/billing/* | IMPLEMENTED AND VERIFIED | billing-webhook-e2e (13), billing-security | raw-body HMAC, fail-closed gates | Razorpay TEST mode | live mode + real charges = owner decision | external |
| 8 | Billing API + console UI (summary/checkout/cancel; Billing tab) | BILLING_ARCHITECTURE.md | src/mcp/transport/billingApi.ts, adminPage.ts | IMPLEMENTED AND VERIFIED | billing-api-e2e (13), billing-ui (12) | session tenant identity, CSRF, XSS-safe rendering | none | payment history/invoices: provider contract supplies none — not fabricated | external |
| 9 | Entitlements + atomic quotas (concurrency-safe) | BILLING_ARCHITECTURE.md | src/billing/billingStore.ts | IMPLEMENTED AND VERIFIED | pg-billing-integration incl. concurrency | insert-claim, FOR UPDATE | Postgres for hosted | none | — |
| 10 | Observability: /healthz, /ready, /metrics, bounded metrics | OPERATIONS_RUNBOOK.md (restored this session) | src/observability/metrics.ts, http-entry.ts | IMPLEMENTED AND VERIFIED | ops-metrics-ready (15) + this session's audit fix | no tenant labels, secrets-free | none | none | — |
| 11 | **Durable post scheduling** (steps 12/16: survive restart, no client session, idempotent, bounded retry, cancel) | master assignment steps 12/16; SCALABILITY.md Phase 2 (durable queue) | src/scheduling/*, tools/scheduleTools.ts, migration m3 | **IMPLEMENTED AND VERIFIED (this session)** | scheduling.test.ts (12) + workspace crash smoke (11/11) | claim-idempotency, tenant scoping, confirm gates, content validation at schedule time | DATABASE_URL (persistence) | timezone-explicit scheduling: stored as ISO UTC; callers convert | low |
| 12 | **Autonomy tiers A–D with confirmation gates** (step 14) | master assignment step 14 | src/policy/autonomyTiers.ts | **IMPLEMENTED AND VERIFIED (this session)** | autonomy-tiers.test.ts (9) | fail-closed on unclassified actions; payload-independent decisions (injection defense) | none | Tier D has no tools (LinkedIn API reality, see #16) | — |
| 13 | Postgres statement_timeout actually applying outside transactions | (defect found this session, step 21) | src/storage/postgresExecutor.ts | **DEFECT → FIXED (this session)** | pg-integration timeout regression (2) | wedged queries can no longer hold pool checkouts | none | none | — |
| 14 | METERED_TOOLS parity with registered catalog | (defect found this session) | src/observability/metrics.ts | **DEFECT → FIXED (this session)** | parity test in ops-metrics-ready | observability accuracy | none | none | — |
| 15 | Docs cited but missing (BILLING_ARCHITECTURE.md, OPERATIONS_RUNBOOK.md) | README.md references | LinkedIn MCP Blueprint/02_ARCHITECTURE + 08_WORKFLOW | **DEFECT → FIXED (this session)** | — | dangling references mislead operators | none | none | — |
| 16 | Job search/application tools | master assignment step 11 vision | **NOT IMPLEMENTED — BLOCKED BY LINKEDIN API ACCESS** | — | — | server description (serverFactory.ts) already excludes; INTEGRATION_LIMITATIONS documents member search as non-self-serve | LinkedIn Talent/partner APIs require approval the project does not hold | full job workflow | external |
| 17 | Messaging/inbox/outreach tools | master assignment step 13 vision | **NOT IMPLEMENTED — BLOCKED BY PLATFORM POLICY** | — | — | NON_GOALS.md excludes scraping/abusive outreach; no supported self-serve messaging API exists | — | full outreach workflow | external |
| 18 | Analytics tools | master assignment step 6.24 vision (P3) | NOT IMPLEMENTED (blueprint "Later" tier) | — | — | — | LinkedIn analytics endpoints require organization/admin APIs | P3 expansion | low |
| 19 | Notifications, recurring task templates beyond post scheduling | master assignment steps 6.28/6.25 vision | NOT IMPLEMENTED (P3) | — | — | — | no delivery channel infra yet | P3 | low |
| 20 | AI client compatibility (ChatGPT, Claude) | MCP_PROTOCOL_DESIGN.md | client-compat-chatgpt.test.ts, client-compat-claude.test.ts | IMPLEMENTED AND VERIFIED | 2 suites against real server | per-client header/quirk handling | none | live-client validation is owner-side | external |

## Documentation inconsistencies found and resolved

1. README cited `02_ARCHITECTURE/BILLING_ARCHITECTURE.md` + `08_WORKFLOW/OPERATIONS_RUNBOOK.md` — **files did not exist** (lost in the baseline replacement commit). Restored this session with content matching the actual implementation.
2. Roadmap reconciliation (M6-era) says M9/M10 = future; they are implemented (CHANGELOG 0.10.0). Roadmap history preserved as history; CHANGELOG is authoritative for status.
3. TECHNICAL_DEVISION's suggested `jobs/` module never existed — now superseded by the implemented `src/scheduling/` (durable queue, Phase-2 item) — no dead doc reference remains.

## Test inventory (this session's final state)

32 test files, 394 tests + this batch: scheduling (12), autonomy tiers (9) → **413 tests across 34 files** in the final state. All green; PG suites on real embedded PostgreSQL; secret scan clean; typecheck/lint/build/audit clean.

## Key external blockers (not code defects)

- **Live LinkedIn validation** (OAuth app, userinfo, real publishing) — requires owner-created LinkedIn app + credentials. Everything is contract-tested against the mock provider and schema-validated against the official API shape.
- **Razorpay live mode** — billing is TEST-mode by design; live keys are an owner deployment secret.
- **Tier D capabilities** (job applications, consequential third-party messaging) — no supported LinkedIn APIs; documented, not faked.
