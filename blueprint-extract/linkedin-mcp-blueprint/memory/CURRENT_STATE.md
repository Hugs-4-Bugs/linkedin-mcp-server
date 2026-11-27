# Current State

**2026-11-27 — MILESTONE 6 (roadmap reconciliation record, staging foundation, real-Postgres tests, Claude+ChatGPT protocol compatibility) COMPLETE & VERIFIED on branch `develop` (pushed to origin/develop; main untouched). Next: Milestone 7 (security hardening) — NOT started, awaiting owner + staging bring-up.**

## Phase 0 → approval → M1 → gate → M2 timeline

- Phase 0 audit complete (report: `/home/z/my-project/download/PHASE_0_REPORT.md`).
- Owner approved with decisions D-A1…D-A10 (recorded in `memory/DECISIONS.md`).
- Condition-10 baseline updates done: `08_WORKFLOW/IMPL_PLAN.md`, ADR-005…012.
- M1 implemented and verified 2026-11-26; owner gate PASSED (findings fixed: body cap + 413, exact route match; loopback + stdout-wire behavioral tests added).
- **M2 implemented and verified 2026-11-26, mock OAuth per owner directive (no credentials required).**
  - `OAUTH_PROVIDER=mock|linkedin` config (linkedin requires full credential triple — config-enforced).
  - `src/auth/linkedin/`: state store (CSRF, single-use, TTL, tenant-bound, timing-safe), AES-256-GCM token vault (in-memory; 32-byte key validated; ephemeral dev key logged-warn), real 3LO adapter (injected fetch; errors mapped, body never leaked) + mock provider (single-use codes), connection service (connect/rate-limit 6 per 10 min/callback/status/disconnect; 60-day expiry).
  - Tools: `linkedin_connect`, `linkedin_status`, `linkedin_disconnect` (schema-forced `confirm: true` gate) registered through policy specs.
  - HTTP routes: `GET /linkedin/connect` (303), `GET /linkedin/callback` (400/200/502 paths), `GET /mock/linkedin/authorize` (mock consent, mock provider only).
  - Security fix during M2: logger redaction extended to OAuth `state`/`code` keys (caught by new hygiene tests).
  - **Suite: 75/75 tests, 10 files** (18 OAuth-foundation, 14 connection service, 6 OAuth-flow E2E over compiled HTTP entry, 4 secret hygiene, plus all M1/M1-gate tests). typecheck ✅ lint ✅ build ✅ audit 0/0 (all+prod) ✅ secret scan ✅.
- Owner directives honored: no scope expansion, pinned deps unchanged (`npm ls` = exact pins), no M3 work started, stopped at M2 boundary with HANDOFF_M2.md.

## M3 (2026-11-26) — profile + granted-scope verification, mock-driven

- **`linkedin_get_my_profile`**: OIDC `GET /v2/userinfo` with the tenant's sealed token; strict permitted-field allowlist (`sub,name,given_name,family_name,email,email_verified,locale,picture` — unexpected fields REJECTED); safe structured errors (`not-connected`/`expired`/`insufficient-scopes`/`provider-*`); real provider: injected fetch, AbortController timeout 10s, 401/403→reconnect guidance, no body leakage; mock: deterministic fixtures that must pass validation themselves; foreign tokens 401.
- **`linkedin_list_granted_scopes`**: truth model — requested vs `tokenScopeClaim` (token-exchange response only) vs `unverified` (no claim), missing/matched, connectionState; explicit note that LinkedIn self-serve has NO introspection endpoint (ADR-013). Requested is never presented as granted.
- **Security tests (17-case matrix)** incl. cross-tenant isolation, no-args schema (identity substitution impossible by construction), token non-leakage canaries, 10-way concurrent profile calls, timeout, mock restrictions.
- **Fix during M3**: expired vs not-connected now distinct error codes; tool clock injectable.
- **Suite 109/109 tests, 13 files**; typecheck/lint/build/audit 0/0/secret-scan clean; pinned deps unchanged; ADR-013 + ADR-014 recorded.
- **LIVE LinkedIn validation NOT performed** (no app credentials — owner-gated; real provider is unit-tested against injected fetch only). Stopped at M3 boundary with HANDOFF_M3.md; no M4 work started.

## M4 (2026-11-27) — publishing tools, verified Posts API contract

- **Tools**: `linkedin_draft_post` (local validation + preview, no persistence), `linkedin_preview_post` (exact submission payload, author from connection), `linkedin_publish_post` (schema-forced `confirm:true` gate; active connection + `w_member_social` via authorize(); author = sealed-token memberSub; 3000-char limit; daily budget; duplicate ledger; NO auto-retry of uncertain writes).
- **Verified API contract (official docs)**: `POST /rest/posts`, text-only body schema, `X-Restli-Protocol-Version: 2.0.0` + `Linkedin-Version: 202611`, 201 + `x-restli-id` URN, 4xx=refusal / timeout+5xx+network=ambiguous, 422 duplicate, 429 throttle. **Rate limits: no numeric quota published** — "150/day" retracted as folklore (ADR-015); app-level `PUBLISH_DAILY_LIMIT=12` (bounded 1–100) + duplicate window are OUR safety limits, never claimed LinkedIn quotas.
- **Write safety (ADR-016)**: local op ledger (content hash + tenant): in-flight lock, duplicate window (10 min default), ambiguous-suspect marking. NOT exactly-once — stated limitations in code + handoff.
- **memberSub persisted** in TokenSet at callback; status surfaces it; publish refuses `identity-unresolved` while sub is pending (real provider until live userinfo).
- **Suite 165/165, 16 files** (+56 M4: 33 tool behavior incl. real-provider request shape via injected fetch, 17 security matrix, 6 HTTP E2E full flow). typecheck/lint/build/audit 0/0/scan clean; pinned deps unchanged; ADR-015/016/017 recorded.
- **LIVE publishing NOT performed** (no credentials — owner-gated since M2). The `urn:li:person:{sub}` author mapping is community-verified, not officially documented — flagged for live confirmation. Stopped at M4 boundary; no M5 work started.

## M5 (2026-11-27) — persistence, remote auth, console, deploy foundation (branch develop)

- **Repo**: remote = github.com/Hugs-4-Bugs/linkedin-mcp-server; M1–M4 history pushed to `origin/develop` BEFORE M5 work (merge 8212a5a; unrelated remote initial commit preserved non-destructively). `main` untouched at 85e6683. PAT used via temp GIT_ASKPASS only.
- **Persistence (ADR-018)**: `SqlExecutor` seam — Postgres (`pg@8.16.0`, only new dep) + SQLite (node:sqlite). Idempotent migrations at startup. SQL stores behind the SAME M2–M4 contracts: vault (AES-256-GCM ciphertext only), state store (atomic single-use), publish ledger + budget (transactional, survive restart). `DATABASE_URL` unset → exact in-memory M4 behavior (166 regression tests prove it).
- **Remote auth (ADR-019)**: scrypt users, digest-at-rest sessions + CSRF, bearer API tokens, audit log; tenant from credentials via AsyncLocalStorage (never caller headers); production fail-fast rejects mock auth/OAuth + requires persistence + vault key. Two real bugs found by our E2E (SDK ALS scope escape; OAuth-route tenant-key split) — both fixed.
- **Remote MCP security**: security headers (CSP default-src 'none'), per-IP rate limit, 413 cap, 401 on /mcp + OAuth routes in persistence mode, bounded redirects, graceful shutdown, /healthz.
- **Console (ADR-020)**: `/admin` self-contained CSP-safe page speaking the real MCP protocol; publish uses the same confirm:true gate (UI cannot bypass).
- **Deploy foundation**: deploy/ = Dockerfile (non-root), compose (app+Postgres17+Caddy TLS), env templates, bootstrapAdmin, runbook. NOT deployed live (owner manual action; see HANDOFF_M5 §7).
- **Suite 212/212 (18 files)**: +25 DB integration, +21 remote-security E2E, +1 config fail-fast; all M1–M4 green (7 tests updated for genuinely-async connect()). lint 0 · audit 0/0 · scan clean.
- **Known limits**: no live deployment/Postgres/TLS/LinkedIn credentials yet; SQLite single-process; no migrate:rollback.

## M6 (2026-11-27) — staging foundation + client compatibility (branch develop)

- **Baseline restored after sandbox recycle** (develop ref + objects survived; main@85e6683 untouched; 212/212 M5 tests re-verified before work).
- **Real PostgreSQL testing** (ADR-021): embedded-postgres@19.0.0-beta.20 (DEV dep only; runtime untouched) — real PG 19 server; 15/15 tests incl. restart survival; **found+fixed a real budget-concurrency race** (`FOR UPDATE` row lock on the PG path).
- **Staging tooling**: `src/scripts/preflight.ts` (PG-validated env/secret/DB/migration checks) + `deploy/staging-smoke.sh` (10/10 in a live rehearsal). SDK contract finding fixed in product+console: initialize must NOT carry MCP-Protocol-Version (-32020).
- **Client compatibility**: client-compat-claude 11/11, client-compat-chatgpt 10/10 — deterministic protocol-level suites (initialize/session/tools/call/auth/errors/reconnect; confirm-gate enforced via protocol). Shared wire contract recorded in MCP_CLIENT_COMPATIBILITY.md. LIVE connector tests NOT performed (owner-side checklists in CLAUDE_/CHATGPT_INTEGRATION.md).
- **GitHub limitation (verified)**: PAT = Contents:write only — milestones/issues/PRs API writes 403. Intended reconciliation recorded machine-applyable in roadmap/ROADMAP_RECONCILIATION_M6.md (10 milestones mapped to 7 execution milestones; no deletes/closes/reassigns). M6 delivered as direct commits on develop; owner opens/merges PRs.
- **Suite 248/248 (21 files)**: +15 PG, +11 Claude, +10 ChatGPT, + config additions; lint 0 · audit 0/0 · scan clean.

## M1 facts (verified)

- Repo: `blueprint-extract/linkedin-mcp-blueprint/` (committed at f601063 = blueprint; M1 code staged on `main`, uncommitted pending owner-visible handoff).
- Runtime: Node v24.22.3, npm 11.19.1; TS 5.9.3 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- SDK pinned: `@modelcontextprotocol/server` **2.4.0** + dev `@modelcontextprotocol/client` **2.4.0** (test-only dep), zod 4.6.7 (via `zod/v4` subpath).
- Working code: `src/` with config validation (zod, fail-fast, local=loopback-only rule), redacting stderr-only logger, tool-policy types, McpServer factory with `status` tool, stdio entry (`serveStdio`), HTTP entry (`createMcpHandler` bridged via node:http, loopback).
- Transports verified end-to-end: stdio via child process + official client (tools/list + tools/call), HTTP via modern 2026-07-28 envelope (`Mcp-Method`/`Mcp-Name` headers, `_meta` namespaced keys) on loopback.
- Test suite: 26 tests / 5 files (unit: config, logger redaction, server factory; integration: stdio E2E, HTTP E2E incl. negative cases 404/406/400-mismatch).
- Quality gates all green: `npm run typecheck`, `lint` (eslint strictTypeChecked + stylisticTypeChecked), `build`, `test` (26/26), `audit` (0 vulnerabilities, all deps), `scan:secrets` (clean).
- Script inventory: `verify` runs typecheck→lint→build→test→audit; `scan:secrets` separate.

## Known gaps (by design, M2+)

- No LinkedIn OAuth yet (M2: 3LO flow, encrypted token vault, expiry/reconnect status, lifecycle tests).
- No persistence yet (M2: Postgres + retention classes).
- HTTP entry is loopback-only; TLS/443 + MCP-side OAuth for Claude connector = M5 staging.
- Graphify not installed yet (nothing to graph; ADR-011 says install post-baseline).
- `scripts/` also holds `secret-scan.sh` (quality gate, not a runtime artifact).
