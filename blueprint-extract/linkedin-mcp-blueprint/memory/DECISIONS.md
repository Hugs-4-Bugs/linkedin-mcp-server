# Decisions

- TypeScript/Node for MCP core.
- Modular monolith first.
- Official LinkedIn APIs only.
- Personal + organization account context, conditional on scopes.
- Local + remote deployment target.
- Claude + ChatGPT compatibility as separate validation tasks.
- Monetization-ready boundaries later; not MVP commitment.

## Owner approval decisions (2026-11-26, quoted from approval message — binding)

- D-A1: MVP = self-serve compliant only (OAuth connection, profile retrieval, post drafting, dry-run + confirmed publishing, disconnect + deletion). No search/invitations/messaging/org-management/analytics without independent verification + approval.
- D-A2: MCP TS SDK v2 preferred; pin exact version; verify Claude/ChatGPT/OAuth/Streamable HTTP/stdio compatibility; documented blockers before any change.
- D-A3: local + staging + production environments designed; NO public production deployment yet.
- D-A4: cost-aware hosting recommendation + staging-domain setup guide required; no provider assumed without justification.
- D-A5: Community Management API application deferred until MVP feasibility/commercial value established.
- D-A6: private pilot posture; architect for multi-tenant SaaS; no public onboarding or monetization yet.
- D-A7: commercial/legal verification before public launch or paid monetization (API agreements, storage/retention rules, lifetime-user limits, privacy, approved capabilities).
- D-A8: security requirements (state validation, secure token storage, tenant isolation, least privilege, tool authorization, audit logging, rate limiting, retention enforcement, disconnect + deletion).
- D-A9: Graphify in local code-analysis mode if verified compatible; advisory only.
- D-A10: implementation only after revised architecture, dependency versions, capability matrix, security design, deployment plan and milestone tasks updated → done in `08_WORKFLOW/IMPL_PLAN.md` + ADR-005…012 (2026-11-26).

## Phase 0 decisions (2026-11-26)

- D-001: Uploaded `LINKEDIN_MCP_MASTER_BUILD_PROMPT.md` (task-level) supersedes the zip's shorter `MASTER_BUILD_PROMPT.md` where they differ; conflict recorded, not silently resolved.
- D-002 (proposed, needs owner approval — ADR-005): MCP SDK v2 line (`@modelcontextprotocol/server` 2.4.0, 2026-07-28 spec, Node ≥20); v1.32.2 is fallback. Rationale: v1 maintenance ends ~early 2027.
- D-003 (proposed — ADR-006): one codebase, two transport adapters (stdio dev / Streamable HTTP 443 prod).
- D-004 (proposed — ADR-011): Graphify adopted in code-only local mode (`graphifyy` via uv; GRAPHIFY_BACKEND=none; no LLM backend, nothing leaves machine); advisory output only; not installed in Phase 0 (no code to graph yet).
- D-005 (fact, not decision): LinkedIn capability ceiling for a new app = OIDC sign-in (`openid profile email`) + Share (`w_member_social`) until LinkedIn approves gated products; all search/messaging/invitation/connection-list capabilities are BLOCKED and will not be simulated.
- D-006 (proposed — ADR-010): storage carries per-class retention (24h/48h/6w/8w/1y per LinkedIn Marketing API storage requirements) with TTL sweeper enforcement.
- D-007 (fact): two isolated OAuth layers — MCP-side auth (server as resource server to Claude/ChatGPT) strictly separated from LinkedIn 3LO client layer; LinkedIn tokens never cross into the MCP-auth layer (tested invariant).
