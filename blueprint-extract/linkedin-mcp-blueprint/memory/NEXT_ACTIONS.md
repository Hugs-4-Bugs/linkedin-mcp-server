# Next Actions

1. Agent: Milestone 8 — release engineering (AGPL release checklist, CI, packaging; issue #15) — AWAITING owner go-ahead.
   ~~M7 done 2026-11-27: threat model + data privacy docs, RetentionSweeper + deleteUser + auditedRun audit wiring (ADR-022), +18 tests → 266/266; issues #12/#16; HANDOFF_M7.md. Owner: review 4 commits on develop (e842f78..612e7ff), PR commands in HANDOFF_M7 §17, apply M6 roadmap reconciliation at convenience.~~
2. Agent: install Graphify code-only (ADR-011) now that the codebase has grown; regenerate per milestone; advisory only.
3. Agent: CI workflow definition once repo hosting/remote is decided (owner D-A4); local `npm run verify` remains the interim gate.
4. OWNER (when ready to go live): create the LinkedIn developer app (Sign In w/ OIDC + Share on LinkedIn), provide Client ID/Secret via secret manager, choose hosting/domain (also needed for staging M5 + redirect URIs). Not blocking M3 mock-driven work.
5. Defer (owner-gated): staging deploy + hosting/cost recommendation (M5), live Claude/ChatGPT validation (M6), security review (M7), Community Management API application, monetization/legal review (D-A7).
