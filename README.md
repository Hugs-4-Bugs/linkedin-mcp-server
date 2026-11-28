# LinkedIn MCP — Engineering Blueprint

This repository is a planning, specification, and agent-operating package for building a LinkedIn MCP server for Claude and ChatGPT. It is not an implementation and does not promise LinkedIn API permissions.

## Decisions
- Stack: Node.js + TypeScript, modular monolith initially.
- MCP: official TypeScript SDK, selected stable release verified at implementation time.
- Integrations: official LinkedIn APIs and approved products/permissions only.
- Accounts: support personal-member and organization/page account contexts only where API access permits.
- Deployment: local development plus remote hosted deployment.
- SaaS-ready design: multi-tenant identity, entitlement/quota interfaces, usage records, billing-ready abstraction; monetization is not part of MVP unless separately approved.
- Clients: Claude and ChatGPT, independently verified against their current MCP connection requirements.

## Start
1. Read `START_HERE.md`.
2. Read `04_AI_AGENT/AGENT_RULES.md` and `AGENT_SYSTEM_INSTRUCTIONS.md`.
3. Read product requirements and architecture documents.
4. Agent must audit API access and client compatibility before implementation.
5. Start only with Phase 0 in `09_PROMPTS/MASTER_PROMPT.md`.

## Important limitation
LinkedIn API availability, permissions, partner program approval, and allowed use are controlled by LinkedIn. The product must not simulate access to unavailable endpoints or use scraping/session-cookie/bypass techniques.

## Scheduling and autonomy (master assignment)

- **Durable post scheduling**: `linkedin_schedule_post` (confirm required) queues a post for future publication that survives server restarts and crashed workers, fires WITHOUT the AI client being connected, and at fire time passes the same safety gates as a manual publish (connection, scope, duplicate window, daily budget, entitlement). `linkedin_list_scheduled_posts` and `linkedin_cancel_scheduled_post` manage the queue. Requires `DATABASE_URL`; in-memory local mode refuses rather than silently losing schedules. Verified end-to-end including a SIGKILL crash-recovery run.
- **Autonomy tiers** (`src/policy/autonomyTiers.ts`): A read/analyze, B prepare, C autonomous execution (confirmation + durable queue + cancellation + bounded retries), D high-impact (no tools today — LinkedIn API reality; any future tool must classify and gate). Unclassified actions fail closed; external content can never relax a tier.
- **Audit deliverable**: the full requirements-to-implementation matrix with statuses and external blockers is in [`LinkedIn MCP Blueprint/08_WORKFLOW/REQUIREMENTS_MATRIX.md`](LinkedIn%20MCP%20Blueprint/08_WORKFLOW/REQUIREMENTS_MATRIX.md).

## Operations (M9/M10)

Hosted SaaS billing (Razorpay TEST mode) and the operational surface are implemented and verified:

- **Billing** (issue #13/#14): HMAC-verified webhook at `POST /webhooks/razorpay` (mounted only when `BILLING_ENABLED=true` + `DATABASE_URL` + secret), entitlement gate on every metered tool call, atomic quota enforcement, console Billing tab served by `GET /api/billing/summary`, `POST /api/billing/checkout`, `POST /api/billing/cancel` (authenticated session + CSRF). Self-hosted (`BILLING_ENABLED=false`, the default) never mounts any of it — see [`LinkedIn MCP Blueprint/02_ARCHITECTURE/BILLING_ARCHITECTURE.md`](LinkedIn%20MCP%20Blueprint/02_ARCHITECTURE/BILLING_ARCHITECTURE.md).
- **Probes & metrics** (issue #17): `GET /healthz` (liveness), `GET /ready` (readiness — real DB probe, 503 when down), `GET /metrics` (Prometheus text, bounded labels, no tenant data). Alert starting points and incident paths: [`LinkedIn MCP Blueprint/08_WORKFLOW/OPERATIONS_RUNBOOK.md`](LinkedIn%20MCP%20Blueprint/08_WORKFLOW/OPERATIONS_RUNBOOK.md).
- **Console UI**: `GET /admin` — self-contained page (CSP-safe, no build step) speaking MCP itself, with the Billing tab.
- **Workspace verification**: `node scripts/workspace-stdio-smoke.mjs` and `node scripts/workspace-http-smoke.mjs` run the real compiled server as live processes and exercise the complete billing + ops surface end to end.

## License and contribution (M8)

This project is licensed under **AGPL-3.0-or-later** — see
[LICENSE](LICENSE) and [NOTICE](NOTICE). A hosted instance of a modified
version must offer Corresponding Source to its network users (AGPL §13);
the release checklist tracks that obligation.

- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md) (gates, DCO sign-off).
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Security reporting: [03_SECURITY/SECURITY_POLICY.md](03_SECURITY/SECURITY_POLICY.md).
- Data handling: [03_SECURITY/DATA_PRIVACY.md](03_SECURITY/DATA_PRIVACY.md).
- Releases: [CHANGELOG.md](CHANGELOG.md) and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
