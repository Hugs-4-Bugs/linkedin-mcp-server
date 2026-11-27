# Milestone 4 Handoff Report — LinkedIn Publishing End-to-End

**Date:** 2026-11-27 · **Status:** COMPLETE, all gates green · **Boundary:** stopped at M4; M5 not started · **Directive:** mock/injected-fetch verification only; no live LinkedIn publishing claimed.

## 1. What was implemented

| Capability | Implementation | Notes |
|---|---|---|
| `linkedin_draft_post` | `src/tools/publishTools.ts` + `src/tools/postValidation.ts` | Local-only: validates text (3000-char documented limit, non-blank, no control chars) and returns a structured draft + preview. No provider call, no connection required, explicitly states drafts are NOT persistently stored. |
| `linkedin_preview_post` | `src/tools/publishTools.ts` | Returns the exact JSON payload a publish would submit, with the author filled from the connected account's memberSub. Local-only; reports validation results and limitations; no side effects. |
| `linkedin_publish_post` | `src/tools/publishTools.ts` + providers | The ONLY side-effecting LinkedIn tool. Schema-forced `confirm: z.literal(true)` gate (confirm:false/missing/string "true"/1 all rejected at the schema boundary before any code runs). Runtime: connection + expiry + `w_member_social` scope checks through `authorize()`, author identity from the sealed token's `memberSub` (never caller-supplied), content validation, daily budget, duplicate ledger, submission, honest outcome. |
| Provider `publishPost` | `src/auth/linkedin/provider.ts` (contract), `realProvider.ts`, `mockProvider.ts` | Real: `POST https://api.linkedin.com/rest/posts` with verified headers (`X-Restli-Protocol-Version: 2.0.0`, `Linkedin-Version: 202611`, Bearer, JSON), 30 s AbortController timeout, URN from `x-restli-id` only, 4xx = write-rejected, 5xx/timeout/network = ambiguous, no body/token echo. Mock: deterministic scripts — success (201-shaped URN), reject-4xx, timeout, ambiguous-5xx, bad-urn (invalid x-restli-id shape), author/token binding enforced (422). |
| Write safety ledger | `src/auth/linkedin/postOperationStore.ts` | SHA-256 content-hash + tenant keyed: in-flight lock, duplicate window (configurable, default 10 min), ambiguous-outcome suspect marking. NO automatic retry of uncertain writes. NOT exactly-once (ADR-016 limitations stated in code + this report). |
| Safety limits | `src/config/config.ts` + `serverFactory.ts` budgets | `PUBLISH_DAILY_LIMIT` (default 12, bounded 1–100) and `PUBLISH_DUPLICATE_WINDOW_MINUTES` (default 10) as APPLICATION safety limits via per-tenant token buckets. LinkedIn's official position: no numeric quota published (see §2). No configuration path can bypass authorization or confirmation. |
| memberSub persistence | `tokenVault.ts` TokenSet + `connectionService.ts` | Callback now persists `memberSub` (the OIDC sub) alongside tokens; `status()` surfaces it. Publish refuses with `identity-unresolved` when the sub is still `pending` (real provider until live userinfo). |

## 2. LinkedIn API facts verified this milestone (official documentation)

Verified against Microsoft Learn (2026-11-27), URLs opened and read:

- **Posts API — Create Organic Posts:** <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-11> — endpoint `POST https://api.linkedin.com/rest/posts`; text-only post body schema (author/commentary/visibility PUBLIC/distribution MAIN_FEED/lifecycleState PUBLISHED/isReshareDisabledByAuthor); 201 + `x-restli-id` post URN; Posts API replaces ugcPosts; error table (400 INVALID_URN/MISSING_FIELD/FIELD_LENGTH, 401, 403 ACCESS_DENIED, 404, 409, 422, 429 TOO_MANY_REQUESTS, 500, 503); `w_member_social` = "Post, comment, and like posts on behalf of an authenticated member"; headers `Linkedin-Version: YYYYMM` + `X-Restli-Protocol-Version: 2.0.0` required on ALL requests.
- **Rate limiting:** <https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits> — daily limits exist (member + application), **"Standard rate limits are not published in documentation"**; look up per-app in the Developer Portal Analytics; 429 on throttle. → ADR-015: no numeric quota is claimed; the 150/day figure is retracted as folklore.
- **UGC Post API (for the 3000-char text limit):** <https://learn.microsoft.com/en-us/linkedin/compliance/integrations/shares/ugc-post-api> — "The maximum length of the text of a UGC Post is 3000 characters"; 422 exact-duplicate response; 429 share-limit responses.
- **OIDC sign-in (identity):** <https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2> — `sub` is the user identifier; pairwise subject type.
- **URNs:** <https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/urns> — `urn:li:person:{id}` format.
- **Versioning/deprecation:** Posts API page warning — Marketing Version 202601 sunsets 2027-01-15; `Linkedin-Version` pinned `202611` (ADR-009).

**Community evidence (NOT official, flagged as such):** the `urn:li:person:{sub}` author mapping for member posts comes from an n8n community thread where a member posted successfully via `/v2/ugcPosts` using the userinfo `sub` as the person URN id. Official docs show organization URN examples but do not explicitly document the member-author mapping on `/rest/posts`. This is recorded in ADR-017 as a to-verify item when live credentials exist.

**Conflict found and corrected (Phase 2 mandate):** the M2-era comment in `provider.ts` cited "150 req/member/day" as documentation — no official source exists; corrected to the verified no-published-quota position (ADR-015). No code behavior depended on the folklore number.

## 3. Verification results (observed 2026-11-27)

```
typecheck → exit 0          lint → exit 0, 0 findings
build → exit 0              vitest → 16 files, 165/165 tests passed
npm audit (all+prod) → 0 vulnerabilities
secret scan → clean (tracked + untracked files)
npm ls → exact pinned versions unchanged
```

New M4 tests: 56 (33 publish tool behavior incl. real-provider request-shape against injected fetch; 17 security matrix; 6 full-flow HTTP E2E over the compiled entry). All 109 M1–M3 tests still green (catalog assertions extended to the 10-tool catalog; one test-rig updated for the new ToolContext fields). HTTP + stdio E2E suites pass against the compiled process.

## 4. Security findings & fixes during M4

1. **Found during implementation:** the mock provider's `exchangeCode` used `Date.now()` directly, making expiry behavior non-deterministic against an injected clock (a test-seeded clock could never observe expiry). Fixed: mock now accepts an injectable `now` (same pattern as the rest of the stack).
2. **Found by the secret scan at final verification:** the new security test carried a token-shaped literal fixture — caught by the scanner (which now reads untracked files, the M3 fix working as intended) and de-literalized at runtime assembly, same pattern as M3.
3. **No authorization bypasses found:** confirmation gate is schema-structural (z.literal(true)); forged author impossible (no author field exists in any schema); cross-tenant publish returns not-connected; tokens never appear in tool responses, errors, or logs (canary-tested, including the redaction filter itself).

## 5. Security test coverage (17-case matrix + E2E)

Disconnected publish · expired connection (stale token never sent) · missing `w_member_social` · forged author identity (schema boundary) · cross-tenant isolation · confirmation bypass attempts (false/"true"/1/missing) · token non-leakage in responses/errors/logs (canary + redaction-filter test) · concurrent identical publish (in-flight lock — single submission) · concurrent different-content publishes · mock refuses foreign tokens · mock enforces author/token binding · config cannot bypass authorization (PUBLISH_DAILY_LIMIT bounded; no env path to disable gates) · real-provider token placement (header only, never URL/body) · 429 body non-echo · HTTP bridge behavior (existing probes green) · stdio protocol integrity (existing suite green).

## 6. Known limitations (honest)

- **Live publishing NOT verified** — no LinkedIn app credentials exist (owner-gated since M2). The real provider is exercised only against injected fetch responses; the mock drives the full tool/E2E flows. Zero live-LinkedIn claims made.
- **Member-author URN mapping is community-verified, not officially documented** (§2) — first live publish must confirm `urn:li:person:{sub}` acceptance; if LinkedIn rejects, the documented fallback research path reopens.
- **Duplicate protection is NOT exactly-once** (ADR-016): timeout-after-accept, process restart, or a second process instance can still produce duplicates; the ledger is in-memory (M5 Postgres scope).
- Drafts are not persisted (stated in tool output — by design this milestone).
- Media/multi-image/article posts, organization-authored posts, mentions, targeting, reshares are out of scope (official docs require asset uploads or org scopes we do not hold).
- Daily budget is a fixed window (rolling 24 h token bucket), not midnight-UTC LinkedIn-style reset.

## 7. Required manual owner actions (non-blocking)

1. LinkedIn developer app + Client ID/Secret (unchanged since M2) — required before ANY live publishing claim; also unlocks verifying the `urn:li:person:{sub}` author mapping.
2. Hosting/domain decision (M5 staging, TLS, redirect URIs).
3. Optional: review `PUBLISH_DAILY_LIMIT` (12/day default) and the duplicate window (10 min) for the intended usage pattern.

## 8. Recommended next milestone

**M5 — remote staging:** 443 TLS termination, MCP OAuth (Claude connector modes), Postgres-backed vault/ledger/budgets (fixes the in-memory limitations above), staging deployment, hosting/cost recommendation document. Client live validation remains M6.

## 9. Commit

Committed after this report; SHA recorded in PROGRESS_TRACKER. Files: `src/tools/{publishTools,postValidation}.ts`, `src/auth/linkedin/{provider,realProvider,mockProvider,tokenVault,connectionService,postOperationStore,publishResult}.ts`, `src/tools/toolContext.ts`, `src/mcp/serverFactory.ts`, `src/config/config.ts`, `tests/unit/publish-tools.test.ts`, `tests/security/publish-security.test.ts`, `tests/integration/publish-flow-e2e.test.ts`, catalog assertions in 3 existing test files, test-rig updates, ADR-015/016/017, `.env.example`, HANDOFF/CURRENT_STATE/NEXT_ACTIONS/TASKS/PROGRESS_TRACKER.
