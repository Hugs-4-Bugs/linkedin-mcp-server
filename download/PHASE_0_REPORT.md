# Phase 0 — Feasibility & Architecture Audit
**Project:** LinkedIn MCP Server (for Claude & ChatGPT)
**Date:** 2026-11-26 · **Prepared by:** Engineering agent (Phase 0 only — no implementation performed)
**Status:** COMPLETE — awaiting owner approval before any coding

Evidence was retrieved 2026-11-26 from official primary sources (Microsoft Learn LinkedIn docs, Anthropic support docs, OpenAI Help Center, modelcontextprotocol.io, npm registry, Graphify GitHub). Confirmed facts are marked CONFIRMED with URL+date; assumptions are marked ASSUMPTION.

---

## 1. Workspace / Repository Audit

| Item | Finding |
|---|---|
| Repository URL | None — no git remote configured (`git remote -v` empty) |
| Branch / HEAD | `main` @ `97daf6d` "Initial commit" |
| Tracked files | 3: `.env`, `.gitignore` (ignores `skills/`, `node_modules/`), `download/README.md` |
| Untracked | `upload/` (source uploads), `blueprint-extract/` (unzipped blueprint, 89 files, 40,799 bytes of docs) |
| Existing code | **None.** No `package.json`, no `src/`, no CI config. Repo is effectively greenfield. No baseline build/test exists (nothing to build). |
| Secrets check | `.env` contains only a local DATABASE_URL path — no credentials present. |
| Toolchain | Node **v24.22.3**, npm **11.19.1**, Python 3.12.16 available. No `tsc`, no Docker, no TypeScript project yet. |

**Verdict:** Repository is EMPTY (greenfield with one boilerplate commit). The uploaded `linkedin-mcp-blueprint/` is the project baseline and must be committed as the initial documentation set (owner action needed on commit policy).

**Blueprint completeness check:** all 10 numbered sections (`01_PRODUCT` … `10_REFERENCE`), `memory/`, `templates/`, `diagrams/`, `09_PROMPTS/` and both master prompts were read in full. No missing or unread files. Conflict noted: the zip's `MASTER_BUILD_PROMPT.md` is a shorter variant of the uploaded `LINKEDIN_MCP_MASTER_BUILD_PROMPT.md`; the uploaded (task-level) version is treated as authoritative per the conflict-order rule, and this is recorded as decision D-001.

---

## 2. LinkedIn Capability & Access Matrix

Legend: status reflects what a **newly created LinkedIn developer app** can do without partner approval, per the official docs below. "Dev tier" = Community Management API Development tier. All Member Permission scopes are 3-legged OAuth.

### 2.1 Self-serve (no application review) — CONFIRMED

| Capability | Official product / endpoint | Scope | App approval | Documented limits | Consent | Status | Evidence (checked 2026-11-26) |
|---|---|---|---|---|---|---|---|
| Sign-in / member identity (name, photo, locale; optional email) | Sign In with LinkedIn using OpenID Connect — `GET https://api.linkedin.com/v2/userinfo`; ID token via `https://www.linkedin.com/oauth/v2/authorization` + `/oauth/v2/accessToken` | `openid profile email` | None (self-serve add in Developer Portal) | OIDC does not verify identity; may not be marketed as such | Member OAuth consent | **AVAILABLE** | learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2 (updated 2024-08-08) |
| Post/comment/like as member | Share on LinkedIn — `POST https://api.linkedin.com/v2/ugcPosts` (`X-Restli-Protocol-Version: 2.0.0` header) | `w_member_social` | None (self-serve add) | **Rate limits: 150 requests/member/day, 100,000 requests/app/day (UTC)** | Member OAuth consent | **AVAILABLE (side-effect)** | learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin (updated 2023-12-14) |
| Attach image/video to shares | `POST https://api.linkedin.com/v2/assets?action=registerUpload` then binary upload | `w_member_social` | None | Same as above | Member consent | **AVAILABLE (side-effect, two-phase)** | same page |

### 2.2 Requires application + LinkedIn review — CONFIRMED as gated

| Capability | Product | Scopes (partial) | Gate | Documented limits | Status | Evidence (checked 2026-11-26) |
|---|---|---|---|---|---|---|
| Read own org posts + engagement | Community Management API | `r_organization_social`, `r_organization_social_feed` | App review ("Community Management API" product); requires established business, legal name/address/privacy policy | **Dev tier: 500 calls/app/24h, 100 calls/member/24h, no BATCH_GET, webhooks disabled**; 12-month build window | **BLOCKED until approval** | learn.microsoft.com/en-us/linkedin/marketing/increasing-access?view=li-lms-2026-11 (updated 2026-10-19); developer.linkedin.com/product-catalog/marketing/community-management-api |
| Post/comment as organization | Community Management API | `w_organization_social`, `w_organization_social_feed` | Same review | Same dev-tier throttles | **BLOCKED until approval** | same |
| Org admin + analytics | Community Management API / Advertising API | `rw_organization_admin`, `r_organization_admin`, `r_organization_followers` | Review; Advertising API requires admin roles | Dev-tier throttles; Standard tier unrestricted | **BLOCKED until approval** | same |
| Member post analytics | Community Management API | `r_member_postAnalytics`, `r_member_profileAnalytics` | Review | Dev-tier throttles | **BLOCKED until approval** | same |
| Organization lookup/management | Community Management API | `rw_organization_admin` | Review | — | **BLOCKED until approval** | same |
| Advertising accounts/reporting | Advertising API | `r_ads`, `rw_ads`, `r_ads_reporting` | Review; two tiers | Dev: read-unlimited, edit ≤5 ad accounts; Standard: unrestricted | **BLOCKED until approval** | same |
| Lead gen retrieval | Lead Sync API | `r_marketing_leadgen_automation` | Review | — | **BLOCKED until approval** | same |
| Boosted posts | Advertising API | `r/rw_member_boost`, `r/rw_organization_boost` (version ≥202610) | Review | — | **BLOCKED until approval** | same |
| Events | Events Management API | `r_events`, `rw_events` | Self-serve **on request** (lightest gated product) | — | **GATED — apply** | learn.microsoft.com …/increasing-access (2026-10-19) |

### 2.3 NOT available — CONFIRMED unavailable to this app today

| Desired capability | Status | Evidence |
|---|---|---|
| Member search / people discovery | **UNAVAILABLE** — no current public API product grants general member search (LinkedIn removed `r_basicprofile` full/connections access for general apps; search is not in the current permission table) | learn.microsoft.com …/increasing-access (2026-10-19): full permission list contains no search scope |
| Messaging / invitations / connections | **UNAVAILABLE** — not in the current Marketing API permission table; no public product grants messaging or invitations | same page (full scope table reviewed) |
| Connection data (full list) | **UNAVAILABLE** — only `r_1st_connections_size` (a count) exists, via gated products | same page |
| Company Intelligence API | **CLOSED** — "not currently accepting new applications" | same page |
| Sales Navigator (SNAP), Talent, Compliance APIs | **CLOSED partner programs** (apply separately; out of scope for MVP) | learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access (updated 2026-06-03) |
| Programmatic refresh tokens | **PARTNER-ONLY** — "Programmatic refresh tokens are available for a limited set of partners." Standard apps refresh by re-running the auth flow (screen bypassed only if member still logged in & token unexpired) | learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow (updated 2026-05-15) |

### 2.4 OAuth & terms facts that shape the architecture (CONFIRMED)

1. **Endpoints:** authorize `https://www.linkedin.com/oauth/v2/authorization`, token `https://www.linkedin.com/oauth/v2/accessToken`; OIDC discovery `https://www.linkedin.com/oauth/.well-known/openid-configuration`, JWKS `https://www.linkedin.com/oauth/openid/jwks`. ID tokens are RS256; `userinfo` at `https://api.linkedin.com/v2/userinfo`.
2. **Token lifetime: 60 days** (`expires_in` = 5184000). No refresh token grant for regular apps → re-auth every ≤60 days is a UX reality that the MCP tool set must expose ("re-connect" tool/status).
3. Redirect URIs must be absolute HTTPS, no `#`, params ignored. `state` param is optional in the docs but CSRF protection is required by our own security baseline → always send & verify.
4. Docs do not document PKCE for LinkedIn's flow (confidential client uses `client_secret` at token exchange). ASSUMPTION (defensible): PKCE may work but is not documented — do not rely on it; use server-side confidential-client flow with `client_secret` kept server-side.
5. **API Terms of Use** (linkedin.com/legal/l/api-terms-of-use): no scraping (explicit), no capture/copy/cache/store of Content except as permitted; stored Content must be identifiable/segregable/deletable; immediate deletion on user request; no selling/aggregating member data; no circumventing rate limits; no multiple apps for similar usage. **Marketing API storage caps:** other members' profile data ≤24h cache; members' social activity ≤48h; orgs' social activity 6 weeks (6 months if org authenticated into the app); org profile 8 weeks (30 days name/logo otherwise); admin/reporting aggregates 1 year. **Consequence:** the server must treat LinkedIn payloads as transient by default, with a retention/TTL design per data class, and a deletion flow. (learn.microsoft.com/en-us/linkedin/marketing/data-storage-requirements, updated 2026-02-02; linkedin.com/legal/l/api-terms-of-use)
6. Versioning: LinkedIn Marketing APIs are versioned (202611 latest; 202601 sunsets 2027-01-15) — the adapter layer must pin and track versions.

---

## 3. MCP / Client Compatibility Matrix

### MCP SDK options (npm registry, checked 2026-11-26 — CONFIRMED)

| Package | Version | Spec | Node engines | Notes |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | **1.32.2** (published 2026-10-23) | implements up to **2025-11-25** | ≥18 | v1 maintenance line; receives bug/security fixes ≥6 months after v2 release (2026-07-27), i.e. through ~early 2027 |
| `@modelcontextprotocol/server` | **2.4.0** (published 2026-10-23) | **2026-07-28** | **≥20** | v2 line: stateless core, `Mcp-Method`/`Mcp-Name` headers, MRTR, CIMD-based auth; server-only package |
| `zod` | 4.6.7 | — | — | schema validation |
| `express` | 5.3.0 | — | — | HTTP framework option |

**Decision needed (owner):** v1 SDK (2025-11-25, stateful sessions, broadest current client support) vs v2 SDK (2026-07-28 stateless, matches where the ecosystem is heading). Recommendation: **start on v2** (`@modelcontextprotocol/server` 2.x) because v1 enters sunset in ~early 2027; verify both Claude and ChatGPT connectors speak 2026-07-28 (they track current spec — ASSUMPTION to be re-verified at Milestone 6 with live tests). Fallback plan: v1 if either client fails against v2.

### Claude (support.claude.com, checked 2026-11-26 — CONFIRMED)

| Requirement | Detail |
|---|---|
| Surfaces | Claude web/desktop/mobile, Cowork — custom connectors on Free/Pro/Max/Ultra/Team/Enterprise |
| Remote transport | **Public HTTPS, port 443 only**, reachable from Anthropic's IP ranges (connections originate from Anthropic cloud, not user device) |
| OAuth client identity | 3 options: **Use Claude's published identity** (recommended), **Register automatically** (dynamic registration), or **Use your own OAuth client** (client ID+secret; redirect URL `https://claude.ai/api/mcp/auth_callback`) |
| Local stdio | Separate mechanism via `claude_desktop_config.json` (local network; not available on claude.ai/cloud Cowork) — usable for development |
| Constraints | Free plan: max 1 custom connector; editing = remove & re-add; no file transfers (beta) |

**Implication:** for remote Claude use, our server must (a) terminate on 443, (b) support Claude-as-OAuth-client hitting our server as an **OAuth resource+authorization server** (MCP auth), and (c) then broker a *separate, server-side* LinkedIn OAuth flow for the end user. Two distinct OAuth layers — exactly what blueprint `AUTHENTICATION_ARCHITECTURE.md` requires us to keep separate.

### ChatGPT (help.openai.com, checked 2026-11-26 — CONFIRMED)

| Requirement | Detail |
|---|---|
| Entry | Plugins → Add custom MCP server (web; Developer Mode no longer required for the plugins flow) |
| Remote transport | Public HTTPS MCP endpoint URL (or Secure MCP Tunnel for private servers); **no stdio** |
| Auth | Per-server auth config; OAuth/OIDC providers must issue **refresh tokens** (`offline_access`) or ChatGPT loses access when the authorization expires |
| Plans | **Business/Enterprise/Edu: full read+write MCP on web. Pro: read/fetch only. Plus/Team: not supported** per current article |
| Governance | Per-connector risk acknowledgment; Business/Enterprise admin controls; frozen tools on server change until admin review |
| Constraints | Web only (no mobile); deep research read-only |

**Implication:** full write tools (e.g., post-as-member) only reach ChatGPT Business/Enterprise users; Pro users get read tools. The tool catalog must be honest about this in docs, not code.

### Combined client/deployment matrix

| Deployment | Claude | ChatGPT |
|---|---|---|
| **Local stdio** | ✅ Claude Desktop via config file (dev only) | ❌ Not supported |
| **Remote HTTPS 443** | ✅ custom connector + OAuth (3 client-identity options) | ✅ Plugins + auth (needs refresh tokens / `offline_access`) — Business/Ent/Edu for writes, Pro read-only |
| Local HTTP on non-443 | ⚠️ Not for remote connector; works only via Desktop stdio proxying | ❌ |

**The killer fact for architecture:** neither client supports local stdio *and* both clients require public HTTPS for remote — so the MVP must be deployable as a public 443 service with an MCP-OAuth layer, plus a stdio mode purely for development. This makes the "local + remote" blueprint goal a single codebase with two transport adapters (as the blueprint already sketches in `SYSTEM_ARCHITECTURE.md`).

---

## 4. Security / Privacy / Compliance Risk Register

| # | Risk | Severity | Mitigation (design-level) |
|---|---|---|---|
| R1 | **Token theft** — 60-day LinkedIn bearer tokens at rest; DB compromise = member account takeover for posts/likes | High | Encrypt at rest (KMS-wrapped envelope, AES-256-GCM), no plaintext tokens, least-privilege DB access, revocation on disconnect, audit without payloads |
| R2 | **No programmatic refresh** — silent expiry every ≤60 days breaks SaaS UX and ChatGPT refresh-token expectations | High | Re-connect tool + expiry status surfaced to clients; never fabricate refresh; treat LinkedIn token as the session anchor |
| R3 | **Prompt injection via LinkedIn content** (post/comment text read via org APIs then fed to model) | High | Content returned as delimited data with no instruction semantics; tool outputs sanitized; treat as untrusted per `PROMPT_INJECTION_DEFENSE.md` |
| R4 | **Data-storage violation** — caching member profile >24h or member social data >48h breaches Marketing API storage caps / API Terms | High | Per-class TTL enforcement in storage layer; default transient; deletion flow; audit fields carry retention class |
| R5 | **OAuth CSRF / redirect attacks** on the LinkedIn callback | High | Mandatory `state` (CSRF token), exact-match redirect allowlist, HTTPS-only redirect URIs, single-use auth codes |
| R6 | **Cross-tenant leakage** in multi-tenant SaaS mode | High | Tenant-scoped queries, tenant isolation tests, separate token vaults per tenant, deny-by-default access checks |
| R7 | **Side-effect tool abuse** (mass posting via `w_member_social`) | Medium-High | Confirmation gates, per-tool quotas, daily rate-limit awareness (150/member/day for shares), no bulk-blast tools by design |
| R8 | **Public endpoint exposure** (SSRF/DoS/abuse) on remote MCP port | Medium | Outbound allowlist to `api.linkedin.com` only, request size limits, per-tenant rate limits, security headers, WAF |
| R9 | **Supply chain** (npm dependency compromise) | Medium | Pinned lockfile, `npm audit`/secret scan in CI, minimal dependency set (SDK + zod + HTTP framework + pg + logger) |
| R10 | **Legal/privacy (GDPR/India DPDP etc.)** before monetization | Medium | Data minimization by default; privacy notice + consent records; **owner must obtain professional legal review before commercial use** (blueprint `DATA_PRIVACY.md` requirement) |
| R11 | **Self-serve Terms constraint**: apps >100k lifetime users / "fundamental aspect of business" not allowed under self-serve terms — monetization at scale requires partner status | Medium | Keep MVP single-owner/low-user; flag partner review before commercial scale-up (API Terms, confirmed) |
| R12 | **MCP auth layer confusion** — server must act as OAuth **resource server** to Claude/ChatGPT while being an OAuth **client** to LinkedIn; miswiring leaks LinkedIn tokens to the wrong layer | High | Two isolated auth modules (`auth/mcp/` vs `auth/linkedin/`), token audience binding, explicit "LinkedIn access token never crosses into MCP-auth layer" invariant + test |
| R13 | **Scraping/automation temptation** — desired capabilities (search, messaging, invitations) are unavailable; risk of "just this once" workaround | High (compliance) | Hard policy: blocked capabilities are documented BLOCKED; no unofficial paths; blueprint `NON_GOALS.md` alignment |

---

## 5. Proposed Architecture & ADRs

Modular monolith, one deployable service, two transports (stdio for dev, Streamable HTTP on 443 for prod). Layers follow blueprint `TECHNICAL_DESIGN.md` modules:

```
src/
  mcp/          # SDK wiring, tool registry, transports (stdio + streamable-http)
  auth/mcp/     # MCP-side OAuth (server-as-resource; CIMD/DCR client mgmt)
  auth/linkedin/# LinkedIn 3LO adapter (authorize/token/userinfo/ugcPosts)
  tools/        # tool catalog: schema(zod), policy metadata, confirmation
  policy/       # scope→tool mapping, confirmation gates, tenant checks
  linkedin/     # official REST client + versioned endpoint adapters
  identity/     # users, tenants, linked-account bindings
  storage/      # Postgres + per-class TTL sweeper, encrypted token vault
  usage/        # usage ledger + quota (monetization-ready seams, no billing)
  observability/ # structured logs (redacted), metrics, traces
  config/       # validated env/config, .env.example only
```

### ADRs (proposed — owner approval = Phase 0 exit)

- **ADR-005 MCP SDK v2 line** (`@modelcontextprotocol/server` 2.4.0, Node ≥20, 2026-07-28 spec). v1.32.2 remains fallback. Rationale: v1 support ends ~early 2027; Node 24 in sandbox satisfies ≥20. *Requires Milestone-6 client verification.*
- **ADR-006 Two-transports, one binary.** stdio adapter for local dev/Claude Desktop; Streamable HTTP for Claude connectors + ChatGPT. No separate code paths beyond the transport adapter.
- **ADR-007 PostgreSQL** for hosted persistence (per blueprint `STORAGE_DESIGN.md`): tokens, tenants, usage, audit. Justification: relational integrity for tenant isolation + audit; managed instance (Neon/Supabase/RDS) avoids self-ops. Local dev: Postgres via Docker or SQLite **only for schemaless local config** — production tokens always encrypted in Postgres, never SQLite-file.
- **ADR-008 Token encryption**: envelope encryption — DEK per row, KEK from secret manager / KMS. No tokens in logs, ever.
- **ADR-009 LinkedIn adapter pins API version** and maps versioned errors to stable MCP error codes; version bump is a reviewed change.
- **ADR-010 Retention-by-class storage**: every persisted LinkedIn-derived field carries a class (member-profile-24h, member-social-48h, org-social-6w, org-profile-8w, aggregate-1y, urn/ids-no-limit, leads-no-limit) and a TTL sweeper enforces it.
- **ADR-011 Graphify decision**: **ADOPT, code-only mode, local only.** `graphifyy` via `uv tool install` (Python 3.11.5–3.14; sandbox has 3.12.16 ✅); run `graphify --code-only` so no LLM backend, nothing leaves the machine, `GRAPHIFY_BACKEND=none`. Output to `graphify-out/` (gitignored). Regenerate at milestones, advisory only — never authoritative over tests. Alternatives if it fails: `madge`/tsc import graphs. NOT installed in Phase 0 (nothing to graph yet).
- **ADR-012 MVP tool surface** (see §6) — strictly self-serve scopes.

---

## 6. Recommended MVP Scope

**In (verified self-serve only):**
1. `health`/`status` tool (server + token state).
2. LinkedIn OAuth connect flow (3LO) for scopes `openid profile email w_member_social`, with `state` CSRF, encrypted token store, expiry status.
3. `get_my_profile` (OIDC userinfo → id/name/photo/locale/email).
4. `create_post` (member text/article/image post via `ugcPosts` + assets) with **mandatory confirmation + dry-run preview** (blueprint §1 requires dry-run for side effects).
5. `connection_status` / `list_granted_scopes` (from token introspection of `scope` claim).
6. stdio dev mode + Streamable HTTP remote mode; per-tool rate-limit awareness (150/member/day share budget).
7. Retention sweeper + disconnect/revoke + data deletion.

**Explicitly out / blocked (documented, not simulated):** org posts & analytics, org management, member/org search, messaging, invitations, connections-list, Sales/Talent APIs — all BLOCKED pending LinkedIn review or partner programs. Ads/Leads/Events deferred.

**Deferred to post-approval phases:** Community Management API tools *contingent on owner applying for and receiving the product approval* (this is an owner action, see §9).

---

## 7. Test & Release Strategy (summary)

- Unit: schemas, policy gates, retention TTL math, token crypto.
- Integration: mocked LinkedIn OAuth + API (nock/msw-style fixtures; no live side effects; synthetic data only).
- MCP contract tests: tool list/schema stability; both transports.
- Security tests: CSRF state, redirect allowlist, injection fixtures, redaction, tenant isolation.
- Client smoke: real Claude connector + real ChatGPT plugin in Milestone 6 (owner provides accounts/plan context).
- Release gates per blueprint `PRODUCTION_READINESS.md`; CI = lint+tsc+tests+audit+secret scan.

## 8. Estimates & Risks (order-of-magnitude, no false precision)

| Milestone | Effort (dev-days) | Primary risk |
|---|---|---|
| M1 Foundation (repo, CI, config, logging, transport skeleton) | 3–5 | toolchain churn |
| M2 LinkedIn OAuth + token vault + lifecycle | 4–6 | 60-day refresh UX; redirect config |
| M3 First read tools (profile, status) | 2–3 | low |
| M4 Share tool + confirmation/dry-run | 3–5 | side-effect safety, rate budget |
| M5 Remote deploy (443, MCP-OAuth for Claude) | 4–7 | CIMD/DCR details vs Claude's 3 identity modes |
| M6 ChatGPT + Claude live validation | 3–5 | plan-level limits (Pro read-only; Plus/Team unsupported) |
| M7 Security review + hardening | 3–4 | finding-driven |
| **Total to production** | **~4–6 weeks focused single-dev** | biggest external risks: LinkedIn app review times (if pursuing gated products), client-side MCP churn |

## 9. Owner Actions Required (blocking before implementation)

1. **Approve Phase 0 report + MVP scope** (this document).
2. **Create the LinkedIn developer app** at developer.linkedin.com; enable products: *Sign In with LinkedIn using OpenID Connect* + *Share on LinkedIn* (both self-serve); provide `Client ID`/`Client Secret` via secret manager; set redirect URL(s) (needs the deployment domain first — decide hosting target, e.g. a small VPS/Fly/Render with TLS on 443).
3. **Decide MCP SDK line**: accept recommendation **v2** (`@modelcontextprotocol/server` 2.x) or override to v1.
4. **Decide hosting platform** (lowest-complexity recommendation: managed Node host + managed Postgres + managed secrets; no K8s).
5. **Decide whether to pursue Community Management API approval** now (unlocks org read/write but review timeline and business-entity requirements apply) or defer. If deferred, MVP ships member-only.
6. **Legal review** (before any monetization; can be deferred for dev-only use): LinkedIn API Terms storage limits, member consent flows, privacy notice. Professional counsel required — flagged, not self-certified.
7. **Decide repo policy**: commit the blueprint docs to git (recommended, no secrets inside), and whether the project gets a dedicated repository/remote.
8. **Provide test context for Milestone 6**: a Claude plan (Pro/Max/Team?) and ChatGPT plan (Plus/Team/Business?) for live client validation; note Plus/Team ChatGPT cannot connect custom MCP servers at all today.

## 10. Questions Genuinely Requiring the Owner

- Q1: Accept SDK v2 recommendation (ADR-005)? Fallback allowed to v1?
- Q2: Hosting platform + domain for the 443 endpoint (needed for LinkedIn redirect URI and Claude connector)?
- Q3: Pursue Community Management API review now or defer org capabilities out of MVP?
- Q4: Is dev-only (no public users) the launch posture, given self-serve Terms' 100k-lifetime-user ceiling and "no fundamental-business" clause until partner status?
- Q5: Who owns the LinkedIn app account long-term (business email, entity) — affects later partner applications?

---
*End of Phase 0 report. STOPPED — no implementation started, per instruction. Next: owner approval → Milestone 1 (foundation).*
