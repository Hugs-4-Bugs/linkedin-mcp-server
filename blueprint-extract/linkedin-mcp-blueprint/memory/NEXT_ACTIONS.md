# Next Actions

1. Agent: Milestone 4 — `draft_post`/`publish_post` (dry-run default, confirmation gate, 150-shares/member/day budget) — AWAITING owner go-ahead; mock fixtures only until credentials exist.
   ~~M3 done 2026-11-26: get_my_profile + granted-scope truth model; HANDOFF_M3.md.~~
2. Agent: install Graphify code-only (ADR-011) now that the codebase has grown; regenerate per milestone; advisory only.
3. Agent: CI workflow definition once repo hosting/remote is decided (owner D-A4); local `npm run verify` remains the interim gate.
4. OWNER (when ready to go live): create the LinkedIn developer app (Sign In w/ OIDC + Share on LinkedIn), provide Client ID/Secret via secret manager, choose hosting/domain (also needed for staging M5 + redirect URIs). Not blocking M3 mock-driven work.
5. Defer (owner-gated): staging deploy + hosting/cost recommendation (M5), live Claude/ChatGPT validation (M6), security review (M7), Community Management API application, monetization/legal review (D-A7).
