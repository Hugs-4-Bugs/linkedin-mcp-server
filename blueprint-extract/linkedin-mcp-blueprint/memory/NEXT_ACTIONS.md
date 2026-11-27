# Next Actions

1. Agent: Milestone 7 — security hardening (threat-model tests, injection fixtures, retention/deletion verification; issues #12/#16) — AWAITING owner go-ahead AND owner's first live staging bring-up.
   ~~M6 done 2026-11-27: real-PG tests (15/15, budget race fixed), preflight + staging smoke (10/10 rehearsal), Claude 11/11 + ChatGPT 10/10 protocol suites, connector docs + live checklists, roadmap reconciliation record (PAT scope-limited); 248/248 tests; ADR-021; HANDOFF_M6.md.~~
2. Agent: install Graphify code-only (ADR-011) now that the codebase has grown; regenerate per milestone; advisory only.
3. Agent: CI workflow definition once repo hosting/remote is decided (owner D-A4); local `npm run verify` remains the interim gate.
4. OWNER (when ready to go live): create the LinkedIn developer app (Sign In w/ OIDC + Share on LinkedIn), provide Client ID/Secret via secret manager, choose hosting/domain (also needed for staging M5 + redirect URIs). Not blocking M3 mock-driven work.
5. Defer (owner-gated): staging deploy + hosting/cost recommendation (M5), live Claude/ChatGPT validation (M6), security review (M7), Community Management API application, monetization/legal review (D-A7).
