# Project Memory

Project: LinkedIn MCP server for Claude and ChatGPT. Scope goal: full feature ambitions but only official API capabilities actually authorized. Personal and organization contexts. Local and hosted deployment. TypeScript/Node selected for MCP ecosystem. Monetization considered later, illustrative ₹99/month; no pricing commitment.

Status: **Phase 0 audit complete 2026-11-26; implementation not started; awaiting owner approval.**

Durable facts established in Phase 0 (full evidence in `/home/z/my-project/download/PHASE_0_REPORT.md`):

- **Capability ceiling (new app, no partner status):** OIDC sign-in (`openid profile email`) + member share/post/comment/like (`w_member_social`; 150 req/member/day, 100k/app/day). Everything else — org data, analytics, search, messaging, invitations, connection lists — requires LinkedIn application review (Community Management API etc.) or closed partner programs; treat as BLOCKED.
- **Token reality:** 60-day access tokens; programmatic refresh tokens are partner-only; documented refresh path is re-running the auth flow. Design reconnect UX accordingly; never fake refresh.
- **Retention reality (Marketing API storage caps):** other-member profile 24h; member social data 48h; org social 6w (6m if authenticated org); org profile 8w (else 30 days name/logo only); aggregates 1y; URN/IDs unrestricted. Storage layer must enforce class-based TTLs.
- **Client reality:** Claude = remote connector needs public HTTPS **port 443** + OAuth (3 client-identity modes; redirect `https://claude.ai/api/mcp/auth_callback`); Free plan 1 connector. ChatGPT = remote HTTPS only via Plugins; **full read+write only Business/Enterprise/Edu; Pro read-only; Plus/Team unsupported**; OAuth providers must issue refresh tokens (`offline_access`). Local stdio only viable via Claude Desktop config for dev.
- **SDK reality:** MCP TS SDK v1.32.2 = 2025-11-25 spec (Node ≥18, maintenance ends ~early 2027); v2 `@modelcontextprotocol/server` 2.4.0 = 2026-07-28 stateless spec (Node ≥20). Recommended: v2, fallback v1, re-verify with live clients in Milestone 6.
- **Graphify:** `Graphify-Labs/graphify`, Python 3.11.5–3.14, PyPI `graphifyy` (double-y; other names unaffiliated), local tree-sitter, code-only mode = no data leaves machine. Adopt code-only local mode (ADR-011); advisory only.
- **Compliance stance:** no scraping/private endpoints/bypasses (blueprint non-goals + LinkedIn API Terms); self-serve terms cap at 100k lifetime users and prohibit "fundamental aspect of business" reliance — partner status needed before commercial scale; legal review is an owner action, never self-certified.

Files that keep this project recoverable: memory/CURRENT_STATE.md, DECISIONS.md, BLOCKERS.md, NEXT_ACTIONS.md, 08_WORKFLOW/TASKS.md, 08_WORKFLOW/PROGRESS_TRACKER.md, and the Phase 0 report (copy in download/).