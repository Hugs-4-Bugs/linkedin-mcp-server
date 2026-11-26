# Milestone 3 Handoff Report — Identity & Granted-Scope Verification

**Date:** 2026-11-26 · **Status:** COMPLETE, all gates green · **Boundary:** stopped at M3; M4 not started · **Directive:** mock/fixture-driven; no live LinkedIn calls claimed.

## 1. What was implemented

| Capability | Implementation | Notes |
|---|---|---|
| `linkedin_get_my_profile` | OIDC `GET https://api.linkedin.com/v2/userinfo` via the tenant's sealed access token (`src/tools/profileTools.ts`, provider `getUserInfo`) | Identity from token, never arguments — tool schema is `{}` strict, so member substitution is impossible by construction. Strict permitted-field allowlist; unexpected fields REJECTED. Errors: `not-connected`, `expired`, `insufficient-scopes`, `provider-timeout`, `provider-http-status` (401/403 → reconnect guidance), `provider-invalid-response`, `provider-network`, `internal`. |
| Real provider userinfo | `src/auth/linkedin/realProvider.ts` | Injected `fetch` (no network in tests); AbortController timeout (10 s default); 401/403 mapped, response bodies never echoed (LEAK-CANARY-tested). |
| Mock provider userinfo | `src/auth/linkedin/mockProvider.ts` | Deterministic fixtures; validates its own fixture (self-checking mock rejects its own invalid config); foreign/real tokens → 401. |
| Strict response validation | `src/auth/linkedin/userinfoSchema.ts` | Permitted keys only; wrong types → field-pointer errors that never echo values; localized-variant keys rejected. |
| Granted-scope verification | `src/auth/linkedin/scopeReport.ts` + `linkedin_list_granted_scopes` tool | Truth model: `requestedScopes`, `tokenScopeClaim` (from token-exchange response only), `verification: token-response \| unverified`, `missingFromClaim`, `connectionState`. LinkedIn self-serve has NO scope-introspection endpoint (Phase 0 research) — the tool states this limitation in its output. Requested is NEVER presented as granted. |
| Runtime enforcement | `authorize()` at tool call; tenant isolation via vault keys | Tools registered with policy metadata (`requiredScopes: ['openid','profile']` for profile); cross-tenant reads return `not-connected` (isolation verified). |
| Architecture record | ADR-013 (scope truth model), ADR-014 (profile capability) in `02_ARCHITECTURE/ARCHITECTURE_DECISION_RECORDS.md` | — |

## 2. Verified capabilities vs unverified (precise, no over-claiming)

**Verified (behavioral tests, mock fixtures + injected fetch):**
- Full 3LO → userinfo round trip over the compiled HTTP entry (E2E, real process).
- Disconnected / expired / insufficient-scope / cross-tenant / forged-identity / malformed-response / timeout / network / concurrency / leak-canary matrix (17 tests).
- Expired tokens distinguished from never-connected (`expired` vs `not-connected` codes).
- HTTP bridge & OAuth callback boundaries intact after M3 (probes: 400/413/404/405).
- Real-provider request shapes (endpoint, Bearer header, query-free URL) against injected fetch.

**NOT verified (stated plainly):**
- **Live LinkedIn userinfo calls** — no app credentials exist (owner-gated). Real provider is exercised only against injected fake fetch responses.
- **Actual granted-scope truth on LinkedIn** — impossible without introspection endpoint or live calls; the truth model reports the exchange-time claim and says so.
- `memberId` from the real provider at callback time remains `pending` until live userinfo can confirm the `sub` (recorded in `realProvider.ts`).

## 3. Verification results (observed 2026-11-26)

```
typecheck → exit 0          lint → exit 0, 0 findings
build → exit 0              vitest → 13 files, 109/109 tests passed
npm audit (all+prod) → 0 vulnerabilities
secret scan → clean         npm ls → exact pinned versions (unchanged)
Regression probes: forged callback 400 · 5MiB body 413 · /mcpfoo 404 · POST on OAuth route 405
```

New M3 tests: 34 (7 userinfo schema · 6 scope truth model · 17 security matrix · 5 HTTP E2E profile flow). All prior M1/M2 tests still green.

## 4. Security findings & fixes

1. **Fixed during M3**: profile tool conflated *expired* with *never-connected* (both fell into scope-empty status). Now distinct structured codes (`expired` with reconnect guidance vs `not-connected`); tool time source made injectable (`ToolContext.now`) for deterministic expiry tests.
2. **Found post-commit, fixed in the M3 amend**: re-running the secret scan against the committed tree FAILED. Two causes: (a) the foreign-token test fixture literal a foreign-token fixture shaped like a LinkedIn token literal matched the repo's LinkedIn-token pattern; (b) `scripts/secret-scan.sh` only scanned `git ls-files`, so the pre-commit "clean" was a **false negative** — new, unstaged test files were invisible to it. Fixes: fixture now assembled at runtime (`.join('-')`), and the scanner scans tracked + untracked-but-present files (`git ls-files --cached --others --exclude-standard`), so a future pre-commit run cannot false-clean on new files. Full pipeline re-verified green after both fixes.
3. No other findings: token/claim/secret non-leakage canaries pass; mock provider refuses foreign tokens (401) and self-rejects invalid fixtures; no bridge/callback regressions (probe-verified).

## 5. Known limitations

- Mock provider default (`OAUTH_PROVIDER=mock`); live LinkedIn behavior (real field presence, real `sub` shape, real scope claim) unverified until credentials exist.
- Scope "grants" are exchange-time claims only; no continuous verification possible (documented in tool output + ADR-013).
- In-memory persistence (restart clears connections) — intended for local dev; Postgres vault is T2.2/M5.
- stdio transport serves the same tools; OAuth connect flow remains HTTP-only (3LO needs browser callback).

## 6. Required manual actions (owner, non-blocking)

1. LinkedIn developer app + Client ID/Secret (secret-manager transfer) — required before ANY live validation claim.
2. Hosting/domain decision — M5 staging, TLS 443, redirect URIs.

## 7. Recommended next milestone

**M4 — posting tools**: `draft_post` (dry-run preview default) and `publish_post` (confirmation gate mirroring `linkedin_disconnect`'s schema-forced `confirm:true`, 150 shares/member/day budget from `TokenBucket`), mock fixtures for the `/rest/posts` API shape. Same directives: mock-driven until credentials, stop at boundary, handoff report.

## 8. Commit

Committed after this report; SHA recorded in the tracker. Files changed: `src/auth/linkedin/{provider,realProvider,mockProvider,userinfoSchema,scopeReport}.ts`, `src/tools/{profileTools,toolContext}.ts`, `src/mcp/serverFactory.ts`, `tests/unit/userinfo-and-scopes.test.ts`, `tests/security/profile-security.test.ts`, `tests/integration/profile-flow-e2e.test.ts`, catalog assertions in 3 existing test files, ADR-013/014, TASKS/PROGRESS_TRACKER/HANDOFF/CURRENT_STATE/NEXT_ACTIONS.
