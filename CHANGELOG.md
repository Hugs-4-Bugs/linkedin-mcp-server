# Changelog

All notable changes to linkedin-mcp-server. Format: Keep a Changelog;
versions follow the roadmap until v1.0.0. Dates are UTC.

## [Unreleased — 2026-11-28d] (next-execution: §7 tool annotations + §8 Agent Skills)

### Added
- MCP tool annotations on every registered tool (readOnlyHint /
  destructiveHint / idempotentHint), derived from each tool's ToolPolicy.
- Server initialize-time instructions pointing agents at the skills.
- Three curated Agent Skills (official SKILL.md format, validated by
  tests/security/agent-skills.test.ts): linkedin-publishing,
  linkedin-post-scheduling, linkedin-connection-troubleshooting.

## [Unreleased — 2026-11-28c] (next-execution program: independent verification + PR4 + README identity)

### Fixed (fresh audit, issue #32)
- P2: budget-exhausted publish no longer strands the content hash as a
  permanent 'in-flight' ledger row (both SQL and memory branches exit()).
- P2: fire-and-forget api_tokens last_used UPDATE is caught — a transient
  DB error no longer fatally terminates the process on Node 24.
- P2: per-client rate limiting is proxy-aware (HTTP_TRUSTED_PROXY; XFF
  honored only from that peer) and the bucket map evicts idle entries;
  behind the shipped Caddy deployment clients no longer share ONE bucket.
- P2: PKCE (S256) added to the OAuth authorization-code flow.
- P3: username-enumeration timing oracle equalized (dummy-hash cost);
  oversized-webhook handler resolves on error/close; subscriptions
  read-modify-write locks FOR UPDATE on Postgres; SESSION_COOKIE_NAME
  honored; billing API routes reject bearer tokens; .env.example matches
  the real key set (drops phantom STAGING_PUBLIC_URL).

### Docs
- README rewritten to the verified identity (implementation + documented
  limitations); Node floor stated as 22.5+ everywhere; recent engineering
  program summary with test counts.

## [Unreleased — 2026-11-28b] (follow-up program: adversarial audit + PR1/PR2/PR3 remediation)

### Fixed (audit findings #22-#29, all evidence-tested)
- P0 #22: scheduled posts bypassed the billing entitlement gate — the
  scheduler executor now passes the SAME withBillingGate + auditedRun
  wrappers as MCP dispatch (entitlement, quota, audit, metrics at fire time).
- P1 #23: autonomy tier policy was dead code — now enforced at dispatch
  (withTierPolicyGuard interposes registerTool; unclassified tools fail closed;
  tier C/D require confirm:true, payload-independent).
- P1 #24: cancel/claim race — markPublished/markFailed guarded by status
  'running'; cancelled-mid-execution rows stay cancelled.
- P1 #25: scheduler tick errors crashed the process — caught + degraded.
- P2 #26: webhook dedupe key derived from SIGNED content (header no longer
  trusted); replays with varied header ids dedupe.
- P2 #27: engines floor corrected to >=22.5.0 (node:sqlite).
- P2 #28: scheduled_posts retention (terminal-only, 90d) + disconnect
  cascade-cancels outstanding schedules.
- P3 #29: claim off-by-one (maxAttempts REAL executions), SQLite partial
  index, correct auth_tag derivation, injected backoff clock, execution
  watchdog, dead seam removal.

## [Unreleased — 2026-11-28] (master assignment: audit, P0/P1 fixes, scheduling, autonomy tiers)

### Fixed (audit findings)
- METERED_TOOLS parity: four metered tool names omitted the linkedin_
  prefix and silently collapsed into the 'other' metrics bucket; a
  bidirectional parity test now guards the catalog (audit P0).
- PostgresExecutor statement_timeout NEVER applied outside transactions:
  plain query()/execute() emitted SET LOCAL outside transaction blocks,
  which PostgreSQL warns about and IGNORES — the per-statement timeout
  only actually worked inside with(). Now session-level via pool
  connect + SET LOCAL retained only on the real transaction path; both
  paths regression-tested with pg_sleep (audit P0, step 21 root cause:
  87 warnings/run eliminated).
- Restored BILLING_ARCHITECTURE.md and OPERATIONS_RUNBOOK.md (cited by
  README/CHANGELOG but removed by the baseline replacement commit).

### Added
- Durable post scheduling (master assignment steps 12/16):
  scheduled_posts table (migration m3), claim-based exactly-once worker,
  bounded retries WITH backoff, restart recovery, cancellation,
  3 confirmed MCP tools (schedule/list/cancel) — refuses in-memory mode
  rather than faking durability. 12 tests + live crash-recovery smoke.
- Autonomy tier model (step 14): A read / B prepare / C autonomous
  execution / D high-impact; exhaustive classification of every
  registered tool, fail-closed on unclassified actions, payload-
  independent decisions (prompt-injection defense at the policy layer).
  9 tests.
- REQUIREMENTS_MATRIX.md: the full audit deliverable (20 requirement
  rows with status/test/security columns + external blockers).

## [0.10.0] — 2026-11-27 (M9 + M10 — Hosted SaaS, Monetization & Scale/Ops)

### Added — M9 (issues #13/#14, hosted SaaS & monetization)
- Billing backend: Razorpay TEST-mode provider contract, HMAC-verified
  webhook route (raw-body capture before parsing, timing-safe compare,
  event-id dedupe), subscription state machine (active/trial/past-due
  grace/expired/canceled/revoked), transactional event application,
  entitlement enforcement gate at tool dispatch (fail-closed), atomic
  quota take with insert-claim first-materialization fix (Postgres FOR
  UPDATE + SQLite, no oversubscription under concurrency).
- Billing REST API (authenticated console surface): GET
  /api/billing/summary (server-authoritative dashboard payload), POST
  /api/billing/checkout (test-mode pending state; NEVER writes
  entitlements — activation is webhook-only), POST /api/billing/cancel
  (cancel-request; revocation only via verified webhook). Session tenant
  identity only, CSRF double-submit, audit rows, billing-disabled
  servers 404 the whole surface.
- Billing UI: complete Billing tab in the /admin console (dashboard,
  usage meter, server-catalog plan grid, payment-pending checkout state,
  two-gate cancellation, self-hosted/session-error/network/exhaustion
  states, XSS-escaped rendering).
- Remediation defects: explicit BILLING_ENABLED boolean parser
  (fail-closed startup validation) and the first-materialization quota
  race; documented webhook_events retention decision (no destructive
  pruning — replay protection preserved).

### Added — M10 (issue #17 area, Scale & Operations)
- In-process metrics registry (zero new dependencies, bounded label
  space, no tenant labels): HTTP requests/errors by route class,
  in-flight gauge, MCP tool call outcomes, billing gate decisions,
  uptime/restart generation.
- GET /metrics (Prometheus text exposition, unauthenticated, secrets-free)
  and GET /ready readiness probe (bounded 1s SELECT 1 through the real
  pool; 503 + reason when the DB is not answering; in-memory always
  ready). Liveness stays /healthz.
- Operational runbook (08_WORKFLOW/OPERATIONS_RUNBOOK.md): probe wiring,
  metric reference, alert starting points, incident quick paths.
- Workspace smoke scripts (stdio + HTTP) that run the real compiled
  server as live processes and exercise the full billing + ops surface.

### Tests
- M9: billing webhook E2E (13), billing API full-stack E2E (13),
  headless UI contract suite (12, jsdom devDependency), PG billing
  integration incl. concurrency; M10: ops-metrics-ready suite (14).
- Full suite 378/378 (31 files), typecheck/lint/build clean, npm audit
  0/0, secret scan clean.

## [0.8.0] — 2026-11-27 (M8 — Release Engineering, issue #15)

### Added
- AGPL-3.0-or-later licensing: full LICENSE text, NOTICE, package.json
  `license` field; dependency license census enforced by an automated
  release-checklist test.
- CONTRIBUTING (gates, DCO sign-off, secret-scan hard gate),
  Contributor Covenant CODE_OF_CONDUCT, expanded SECURITY_POLICY
  (reporting channel, SLA, scope), RELEASE_CHECKLIST.
- GitHub Actions CI (typecheck/lint/build/full tests/audit).

## [0.7.0] — 2026-11-27 (M7 — Security Hardening, issues #12/#16)

### Added
- THREAT_MODEL (assets, trust boundaries, 14-row STRIDE with test
  evidence) and DATA_PRIVACY (per-class retention table, deletion
  semantics, log hygiene).
- RetentionSweeper per-data-class TTL enforcement + PeriodicSweeper
  runtime wiring (ADR-010/D-006 closed); transactional account removal
  (deleteUser); auditedRun tool-call audit coverage (ADR-022).
- 18 regression tests (retention 9, threat-model 7, real-PG 2).

## [0.6.0] — 2026-11-27 (M6 — Claude & ChatGPT Integration)

### Added
- Real-PostgreSQL integration suite (embedded-postgres 19, tenant
  isolation, budget races, restart survival), staging preflight +
  smoke scripts, Claude/ChatGPT client compatibility suites, connector
  docs, roadmap reconciliation record.

## [0.5.0] — 2026-11-27 (M5 — Persistence & Production Infrastructure)

### Added
- SQL persistence (Postgres/SQLite) behind the same vault/budget/ledger
  contracts; AES-256-GCM ciphertext-only token rows; migrations;
  credential auth (scrypt, digest-at-rest sessions/API tokens, CSRF);
  Docker/compose staging topology (ADR-018/019).

## [0.4.0] — 2026-11-27 (M4 — Publishing & Write Safety)

### Added
- linkedin_draft_post / preview_post / publish_post tools with
  confirm:true schema gate, content validation, duplicate window,
  in-flight lock, daily budget, no auto-retry on ambiguous writes;
  op ledger with write-safety accounting (ADR-015/016/017).

## [0.3.0] — 2026-11-26 (M3 — Member Profile & Scope Transparency)

### Added
- linkedin_get_my_profile (OIDC userinfo, strict allowlist, ADR-014),
  granted-scope truth model + linkedin_list_granted_scopes (ADR-013).

## [0.2.0] — 2026-11-26 (M2 — LinkedIn OAuth & Connection Lifecycle)

### Added
- 3LO OAuth connect/status/disconnect tools, CSRF state store,
  AES-256-GCM token vault, connect-rate limit, mock provider with
  deterministic fixtures.

## [0.1.0] — 2026-11-26 (M1 — Foundation & MCP Infrastructure)

### Added
- MCP server (stdio + Streamable HTTP), strict TypeScript, zod config
  validation, redacting logger, loopback/body-cap transport tests.
