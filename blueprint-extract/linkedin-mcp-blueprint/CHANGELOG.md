# Changelog

All notable changes to linkedin-mcp-server. Format: Keep a Changelog;
versions follow the roadmap until v1.0.0. Dates are UTC.

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
