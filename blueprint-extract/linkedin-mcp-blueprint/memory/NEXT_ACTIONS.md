# Next Actions

1. Agent: Milestone 10 (Scale & Operations) — NOT started; owner-gated approval required first.
   ~~M9 done 2026-11-27: issues #13/#14 COMPLETE on local develop (73dc145..d0ef295, +52 tests → 330/330; typecheck/lint/build/audit/scan green; zero dep changes; HANDOFF_M9.md).~~
   M9 owner items: PUSH develop (no PAT in session env — `git push origin develop` after authenticating; see HANDOFF_M9 §26); staging bring-up (BILLING_ENABLED + DATABASE_URL + RAZORPAY_WEBHOOK_SECRET in Razorpay TEST mode, webhook → POST /webhooks/razorpay); validate first real signed delivery; decide plan catalog + checkout flow; approve M10 before next milestone.
2. Agent: install Graphify code-only (ADR-011) now that the codebase has grown; regenerate per milestone; advisory only.
3. Agent: CI workflow definition once repo hosting/remote is decided (owner D-A4); local `npm run verify` remains the interim gate.
4. OWNER (when ready to go live): create the LinkedIn developer app (Sign In w/ OIDC + Share on LinkedIn), provide Client ID/Secret via secret manager, choose hosting/domain (also needed for staging M5 + redirect URIs). Not blocking M3 mock-driven work.
5. Defer (owner-gated): staging deploy + hosting/cost recommendation (M5), live Claude/ChatGPT validation (M6), security review (M7), Community Management API application, monetization/legal review (D-A7).
