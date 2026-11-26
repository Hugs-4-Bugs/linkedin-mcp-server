# Architecture Decision Records

## ADR-001: TypeScript MCP core
Status: proposed/approved by blueprint owner. Reason: first-party MCP SDK maturity and integration velocity. Java remains viable but not selected.

## ADR-002: Modular monolith
Start with clear module boundaries; avoid premature microservices.

## ADR-003: Official LinkedIn API only
Do not use scraping, cookie auth, private endpoints, or bypasses.

## ADR-004: Monetization-ready interfaces, not monetization MVP
Build identity, tenant, quota and entitlement seams. Implement payments only after validation and owner approval.

## ADR-005: MCP TypeScript SDK v2 line (owner-approved 2026-11-26, decision D-A2)
Pin `@modelcontextprotocol/server` **2.4.0** (Apache-2.0, Node ≥20, implements 2026-07-28 MCP spec). Verified 2026-11-26 via npm registry. v1 (`@modelcontextprotocol/sdk` 1.32.2, 2025-11-25 spec) is the documented fallback if a verified Claude/ChatGPT/OAuth/Streamable-HTTP/stdio blocker appears; any switch requires evidence documented in a new ADR. Version bumps require ADR update — never silent.

## ADR-006: One codebase, two transports (owner-aligned, Phase 0 D-003)
stdio adapter (`serveStdio` from `@modelcontextprotocol/server/stdio`) for local dev; Streamable HTTP for staging/remote. No feature logic in transport layers.

## ADR-007: PostgreSQL for hosted persistence (staging/production)
Managed Postgres for staging+prod (tokens, tenants, usage, audit). Local dev runs ephemeral in-memory stores; no LinkedIn network calls in unit/protocol tests. Selected over SQLite-at-rest for relational tenant isolation and audit integrity.

## ADR-008: Envelope-encrypted token vault
LinkedIn access tokens (60-day bearer tokens) encrypted at rest: per-row DEK, KMS/secret-manager KEK. No plaintext tokens in DB, logs, or tool output. Enforced from Milestone 2 onward.

## ADR-009: LinkedIn adapter pins API versions
Adapters pin and track LinkedIn API versions (202611 current; 202601 sunsets 2027-01-15); version changes are reviewed changes with tests.

## ADR-010: Retention-by-class storage
Every persisted LinkedIn-derived field carries a retention class per Marketing API storage requirements (other-member profile 24h; member social 48h; org social 6w/6m; org profile 8w; aggregates 1y) with a TTL sweeper enforcing expiry. Implemented with storage layer (M2+).

## ADR-011: Graphify advisory-only, code-only local mode (owner-approved D-A9)
Use `Graphify-Labs/graphify` (PyPI `graphifyy`, Python 3.11.5–3.14; local tree-sitter parsing) in `--code-only` mode with no LLM backend (`GRAPHIFY_BACKEND=none`); nothing leaves the machine; `graphify-out/` is gitignored. Output is advisory navigation context; it never replaces tests, code review or architectural verification. Install deferred until a codebase exists.

## ADR-012: MVP tool surface = self-serve scopes only (owner-approved D-A1)
`openid profile email w_member_social`. Org/analytics/search/messaging/invitations are BLOCKED until independently verified and owner-approved. Deployment: local + staging only; no public production (owner D-A3); private-pilot posture (D-A6).
