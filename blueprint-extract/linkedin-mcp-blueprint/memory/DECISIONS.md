# Decisions

- TypeScript/Node for MCP core.
- Modular monolith first.
- Official LinkedIn APIs only.
- Personal + organization account context, conditional on scopes.
- Local + remote deployment target.
- Claude + ChatGPT compatibility as separate validation tasks.
- Monetization-ready boundaries later; not MVP commitment.

## Phase 0 decisions (2026-11-26)

- D-001: Uploaded `LINKEDIN_MCP_MASTER_BUILD_PROMPT.md` (task-level) supersedes the zip's shorter `MASTER_BUILD_PROMPT.md` where they differ; conflict recorded, not silently resolved.
- D-002 (proposed, needs owner approval — ADR-005): MCP SDK v2 line (`@modelcontextprotocol/server` 2.4.0, 2026-07-28 spec, Node ≥20); v1.32.2 is fallback. Rationale: v1 maintenance ends ~early 2027.
- D-003 (proposed — ADR-006): one codebase, two transport adapters (stdio dev / Streamable HTTP 443 prod).
- D-004 (proposed — ADR-011): Graphify adopted in code-only local mode (`graphifyy` via uv; GRAPHIFY_BACKEND=none; no LLM backend, nothing leaves machine); advisory output only; not installed in Phase 0 (no code to graph yet).
- D-005 (fact, not decision): LinkedIn capability ceiling for a new app = OIDC sign-in (`openid profile email`) + Share (`w_member_social`) until LinkedIn approves gated products; all search/messaging/invitation/connection-list capabilities are BLOCKED and will not be simulated.
- D-006 (proposed — ADR-010): storage carries per-class retention (24h/48h/6w/8w/1y per LinkedIn Marketing API storage requirements) with TTL sweeper enforcement.
- D-007 (fact): two isolated OAuth layers — MCP-side auth (server as resource server to Claude/ChatGPT) strictly separated from LinkedIn 3LO client layer; LinkedIn tokens never cross into the MCP-auth layer (tested invariant).
