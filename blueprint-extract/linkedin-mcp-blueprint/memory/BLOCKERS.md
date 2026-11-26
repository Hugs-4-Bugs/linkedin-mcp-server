# Blockers

**2026-11-26 (post-M1):**

1. **No LinkedIn developer app yet (BLOCKING M2 REAL-DATA WORK)** — owner must create it, enable Sign In w/ OIDC + Share on LinkedIn, supply Client ID/Secret via secret manager, set HTTPS redirect URIs. M2 code proceeds with mocked OAuth until then; nothing live can be claimed.
2. **Deployment domain/hosting undecided (owner Q2/D-A4)** — required for LinkedIn redirect URIs and the Claude connector's 443 requirement; also gates CI workflow file (repo remote unknown) and the M5 hosting/cost recommendation doc.
3. **Gated LinkedIn products (org/analytics/messaging/search) remain BLOCKED** per owner D-A5 (deferred) and LinkedIn review requirements. Programmatic refresh tokens are partner-only — 60-day manual re-auth is a permanent constraint absent partner status.
4. **Client plan coverage unknown** — ChatGPT Plus/Team cannot connect custom MCP servers at all today; Pro is read-only. Owner must confirm available plans for Milestone 6 live validation.
5. **Legal review outstanding** (owner D-A7): LinkedIn API Terms storage caps + self-serve ceilings (100k lifetime users, no "fundamental aspect of business") require professional counsel before public launch or paid monetization.
6. Host compatibility documented (docs-level) but NOT live-tested — deferred to T4.1/T4.2 by design.

**Resolved since Phase 0:**
- ~~Owner approval of Phase 0~~ — approved 2026-11-26 (D-A1…D-A10).
- ~~SDK line undecided~~ — v2 `@modelcontextprotocol/server` 2.4.0 pinned and verified against both transports (M1 evidence).
- ~~No code/test baseline~~ — M1 foundation complete, 26/26 tests, full verify pipeline green.
