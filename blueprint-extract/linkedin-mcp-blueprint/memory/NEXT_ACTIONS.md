# Next Actions

1. Agent: Milestone 3 — `get_my_profile` (OIDC userinfo endpoint adapter + mock fixtures) + granted-scope introspection tool. Real calls require owner's LinkedIn app (still not provided); mock/fixture-driven implementation and tests proceed.
2. Agent: install Graphify code-only (ADR-011) now that the codebase has grown; regenerate per milestone; advisory only.
3. Agent: CI workflow definition once repo hosting/remote is decided (owner D-A4); local `npm run verify` remains the interim gate.
4. OWNER (when ready to go live): create the LinkedIn developer app (Sign In w/ OIDC + Share on LinkedIn), provide Client ID/Secret via secret manager, choose hosting/domain (also needed for staging M5 + redirect URIs). Not blocking M3 mock-driven work.
5. Defer (owner-gated): staging deploy + hosting/cost recommendation (M5), live Claude/ChatGPT validation (M6), security review (M7), Community Management API application, monetization/legal review (D-A7).
