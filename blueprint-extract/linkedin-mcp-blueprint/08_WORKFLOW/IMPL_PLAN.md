# Implementation Plan — Approved Post-Phase-0 Baseline

**Owner approval date:** 2026-11-26 (Phase 0 decisions 1–10, quoted in `memory/DECISIONS.md` as D-A1…D-A10).
**Status:** This document locks the revised architecture, pinned dependency versions, security design, deployment plan and milestone task list required by owner condition 10 before implementation.

## 1. Scope locked by owner

MVP (self-serve compliant only): LinkedIn OAuth connection, authorized profile retrieval, post drafting, dry-run + confirmed post publishing, disconnect + deletion. **Out until independently verified and approved:** search, invitations, messaging, organization management, analytics. No public production deployment; local + staging environments only. Private-pilot posture; SaaS-ready seams but no public onboarding or monetization.

## 2. Pinned dependency versions (verified against npm registry 2026-11-26)

| Dependency | Exact version | License | Node engines | Purpose |
|---|---|---|---|---|
| `@modelcontextprotocol/server` | **2.4.0** | Apache-2.0 | ≥20 | MCP server core (2026-07-28 spec) |
| `zod` | 4.6.7 | MIT | — | schema validation (SDK dep: `^4.2.0`) |
| `typescript` | **5.9.3** | Apache-2.0 | — | compiler (7.0.2 exists but is a major release this week; 5.9 line is the conservative pinned choice, upgradable by ADR) |
| `@types/node` | 24.19.4 | MIT | — | matches Node 24 runtime |
| `vitest` | 5.1.2 | MIT | — | test runner |
| `tsx` | 4.20.3 (dev) | MIT | — | dev-time execution only; runtime uses compiled JS |
| `@modelcontextprotocol/express` / `express` | 2.0.2 / 5.3.0 | Apache-2.0 / MIT | — | remote transport middleware (deferred to M5 remote milestone, listed for planning) |

Rule (owner D-A2 / ADR-005): version changes require a documented ADR update with evidence of a verified blocker or a maintenance need; never silently bumped.

## 3. Environments

| Env | Transport | Purpose | Storage |
|---|---|---|---|
| `local` | stdio (`serveStdio`) + loopback Streamable HTTP | development + unit/protocol tests | ephemeral in-memory; no real LinkedIn calls |
| `staging` | Streamable HTTP, TLS 443 on a staging domain | client-compatibility validation (Claude connector, ChatGPT plugin) | managed Postgres (staging) |
| `production` | — | **NOT ESTABLISHED per owner condition 3** | — |

Local/staging/production environment boundaries are enforced in `src/config/` via an `ENVIRONMENT` enum; staging/production require explicit secret-manager-provided values (no `.env` file loading in production).

## 4. Module boundaries (final)

```
src/
  mcp/            # McpServer wiring, tool registry, transports
  mcp/transport/  # stdio + streamable-http adapters (M1: skeleton, M4: full)
  tools/          # tool definitions: schema(zod), policy metadata, confirmation class
  policy/         # scope→tool mapping, confirmation gates, tenant checks
  auth/linkedin/  # LinkedIn 3LO adapter (M2)
  identity/       # users, tenants, linked-account bindings (M2)
  storage/        # Postgres persistence + retention sweeper (M2/M5)
  linkedin/       # official REST client: userinfo, ugcPosts, assets (M2/M3/M4)
  usage/          # usage ledger + quota seams (no billing) (M5+)
  observability/  # redacting structured logger (M1), metrics/trace seams
  config/         # validated env config, .env.example only
  shared/         # result/error types, time, ids, crypto helpers
tests/unit/ tests/integration/ tests/security/
docs/
```

## 5. Security design for the foundation milestone (M1)

- Config schema validated with zod at startup; fail-fast on missing/invalid; `.env.example` with placeholders only; `.env` gitignored.
- Logger writes structured JSON to stderr (never stdout — stdout is the stdio protocol channel); token/secret redaction filter with `REDACT` markers; correlation IDs.
- No LinkedIn network calls in M1. `tools` catalog starts with `health`/`status` only; every tool descriptor carries scope requirements, side-effect class, confirmation class and audit hooks per `MCP_PROTOCOL_DESIGN.md`.
- Transport tests verify: tool list schema stability, stdio protocol handshake, streamable HTTP route, and that no secrets appear in stdout/stderr streams.
- Dependency hygiene: exact pinned versions in `package.json`, `npm audit` + secret scan in CI script; `npm ls` verification recorded in M1 evidence.

## 6. Milestones (task board mapping)

| Milestone | Deliverable | Maps to TASKS.md |
|---|---|---|
| M1 Foundation | repo skeleton, pinned deps, tsconfig strict, config validation, redacting logger, stdio + streamable-http MCP skeleton, health/status tool, vitest suite, lint/typecheck/audit scripts | T1.1, T1.2 |
| M2 LinkedIn auth | 3LO flow for `openid profile email w_member_social`, encrypted token vault, expiry/reconnect status, lifecycle tests | T2.1, T2.2 |
| M3 Read tools | `get_my_profile` (OIDC userinfo), granted-scope introspection | T3.1 |
| M4 Share tools | `draft_post` + `publish_post` (dry-run default, confirmation gate, rate-budget aware) | T3.2 |
| M5 Remote staging | 443 TLS, MCP OAuth (Claude connector modes), staging deploy, hosting/cost recommendation doc | T6.1 (staging only) |
| M6 Client validation | live Claude + ChatGPT tests per compatibility matrix | T4.1, T4.2 |
| M7 Security review | threat-model tests, tenant isolation, injection fixtures | T5.1 |
| M8+ | production readiness audit, (separately approved) production deploy, monetization/legal | T7.1, T8.1 |

## 7. Change control

- Any deviation from this plan (scope, deps, architecture, security) = new ADR + owner approval before proceeding.
- Every milestone ends with: working code, tests, verification evidence (commands + observed output), memory/task-board updates, handoff report. No claimed completion without evidence.
