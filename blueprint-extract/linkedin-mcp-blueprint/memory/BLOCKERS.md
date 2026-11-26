# Blockers

**2026-11-26 (Phase 0):**

1. **Owner approval of Phase 0 report pending** — implementation is gated on it (`/home/z/my-project/download/PHASE_0_REPORT.md`).
2. **No LinkedIn developer app exists yet** (owner must create it, enable Sign In w/ OIDC + Share on LinkedIn products, supply Client ID/Secret via secret manager, set HTTPS redirect URIs). Without it, nothing beyond mocked tests is possible.
3. **Deployment domain/hosting undecided** (Q2) — needed for LinkedIn redirect URIs and the Claude connector's 443 requirement.
4. **SDK line not yet owner-approved** (Q1): recommendation v2 `@modelcontextprotocol/server`; fallback v1.
5. **Gated LinkedIn products (org/analytics/messaging/search) remain blocked** until owner applies and LinkedIn approves Community Management API etc. (Q3). Programmatic refresh tokens are partner-only — 60-day manual re-auth is a permanent constraint unless partner status is granted.
6. **Client plan coverage unknown** (Q5/§9.8): ChatGPT Plus/Team cannot connect custom MCP servers at all today; Pro is read-only. Owner must confirm which plans they have for Milestone 6 validation.
7. **Legal review outstanding** (R10/R11): LinkedIn API Terms storage caps + self-serve ceilings (100k lifetime users, no "fundamental aspect of business") require professional counsel before any monetization.
8. Host compatibility documented (docs-level) but NOT live-tested — deferred to T4.1/T4.2 by design.