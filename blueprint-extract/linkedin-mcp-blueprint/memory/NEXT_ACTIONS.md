# Next Actions

1. **OWNER (blocking M2): Create the LinkedIn developer app** — enable *Sign In with LinkedIn using OpenID Connect* + *Share on LinkedIn* (both self-serve), configure HTTPS redirect URIs (needs hosting decision Q2/D-A4), transfer Client ID/Secret via secret manager. Until then M2 proceeds with mocked OAuth only.
2. Agent: Milestone 2 — LinkedIn 3LO for `openid profile email w_member_social`: authorize/token endpoints, state+CSRF, encrypted token vault (envelope encryption ADR-008), 60-day expiry status + reconnect UX, lifecycle/disconnect tests (mocked until real app credentials exist).
3. Agent: Milestone 3 — `get_my_profile` (OIDC userinfo) + granted-scope introspection tools (mocked fixtures until real app).
4. Agent: Milestone 4 — `draft_post`/`publish_post` (dry-run default, confirmation gate, share rate budget 150/member/day).
5. Agent: install Graphify code-only (ADR-011) now that a codebase exists; regenerate per milestone; advisory only.
6. Agent: CI workflow definition once repo hosting/remote is decided (owner D-A4); local `npm run verify` is the interim gate.
7. Defer (owner-gated): staging deploy + hosting/cost recommendation (M5), live Claude/ChatGPT validation (M6), security review (M7), Community Management API application, monetization/legal review.
