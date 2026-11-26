# Current State

**2026-11-26 — Phase 0 (feasibility & architecture audit) COMPLETE. Awaiting owner approval before implementation.**

- Workspace: greenfield repo (`main` @ 97daf6d, no remote, no code yet). Blueprint extracted to `blueprint-extract/linkedin-mcp-blueprint/` and fully read (89 files).
- Phase 0 deliverable: `/home/z/my-project/download/PHASE_0_REPORT.md` (capability matrix, MCP compatibility matrix, risk register R1–R13, ADRs 005–012 proposed, MVP scope, estimates, owner questions Q1–Q5).
- Key verified facts (evidence URLs + dates in report):
  - LinkedIn self-serve scopes only: `openid profile email` (Sign In w/ OIDC) and `w_member_social` (Share on LinkedIn, 150 req/member/day, 100k req/app/day). All org/analytics/messaging/search capabilities are BLOCKED pending LinkedIn application review; programmatic refresh tokens are partner-only; access tokens last 60 days.
  - Marketing API storage caps confirmed (24h other-member profile cache, 48h member social, 6w/6m org social, 8w org profile, 1y aggregates).
  - MCP SDK: v1.32.2 (2025-11-25 spec, Node ≥18) vs v2 `@modelcontextprotocol/server` 2.4.0 (2026-07-28 stateless spec, Node ≥20). Recommendation: v2.
  - Claude remote connectors: public HTTPS port 443 only, OAuth via Claude's published identity / auto-register / own client (redirect `https://claude.ai/api/mcp/auth_callback`); Free plan = 1 connector.
  - ChatGPT: remote HTTPS MCP only via Plugins; full read+write = Business/Enterprise/Edu, Pro = read-only, Plus/Team unsupported; OAuth providers must issue refresh tokens (`offline_access`).
  - Graphify = `Graphify-Labs/graphify` (Python, pip name `graphifyy`, local tree-sitter). Decision: ADOPT code-only local mode (ADR-011), not yet installed.
- Next: owner answers Q1–Q5 (SDK line, hosting/domain, Community Management API pursuit, launch posture, app ownership) and approves → Milestone 1 (foundation).
