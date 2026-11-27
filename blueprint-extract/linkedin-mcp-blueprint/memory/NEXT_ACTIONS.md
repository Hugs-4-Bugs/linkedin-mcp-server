# Next Actions

1. Agent: Milestone 9 — hosted SaaS/billing (issues #13/#14) — REQUIRES EXPLICIT OWNER APPROVAL FIRST (roadmap record: "separately owner-approved"; self-hosting must not require hosted payment — issue #14 constraint). Do NOT start billing code without it.
   ~~M8 done 2026-11-27: AGPL LICENSE/NOTICE + package metadata (0.8.0), CONTRIBUTING/COC/SECURITY_POLICY, CHANGELOG/RELEASE_CHECKLIST, CI workflow, 12 release-checklist tests → 278/278; issue #15; HANDOFF_M8.md.~~
   M8 owner items: review commits da8c0fd..cad8a09; flip `private` at publish; set COC contact (or keep SECURITY.md cross-ref); enable security advisories + tag protection; enable Actions for ci.yml.
2. Agent: install Graphify code-only (ADR-011) now that the codebase has grown; regenerate per milestone; advisory only.
3. Agent: CI workflow definition once repo hosting/remote is decided (owner D-A4); local `npm run verify` remains the interim gate.
4. OWNER (when ready to go live): create the LinkedIn developer app (Sign In w/ OIDC + Share on LinkedIn), provide Client ID/Secret via secret manager, choose hosting/domain (also needed for staging M5 + redirect URIs). Not blocking M3 mock-driven work.
5. Defer (owner-gated): staging deploy + hosting/cost recommendation (M5), live Claude/ChatGPT validation (M6), security review (M7), Community Management API application, monetization/legal review (D-A7).
