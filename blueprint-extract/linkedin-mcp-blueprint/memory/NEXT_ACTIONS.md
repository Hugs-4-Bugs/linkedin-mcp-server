# Next Actions

1. Agent: Milestone 6 — client compatibility (live Claude + ChatGPT against the remote endpoint, compatibility matrix, first real staging bring-up using deploy/) — AWAITING owner go-ahead.
   ~~M5 done 2026-11-27: persistence + remote auth + console + deploy foundation, 212/212 tests, ADR-018/019/020; HANDOFF_M5.md.~~
2. Agent: install Graphify code-only (ADR-011) now that the codebase has grown; regenerate per milestone; advisory only.
3. Agent: CI workflow definition once repo hosting/remote is decided (owner D-A4); local `npm run verify` remains the interim gate.
4. OWNER (when ready to go live): create the LinkedIn developer app (Sign In w/ OIDC + Share on LinkedIn), provide Client ID/Secret via secret manager, choose hosting/domain (also needed for staging M5 + redirect URIs). Not blocking M3 mock-driven work.
5. Defer (owner-gated): staging deploy + hosting/cost recommendation (M5), live Claude/ChatGPT validation (M6), security review (M7), Community Management API application, monetization/legal review (D-A7).
