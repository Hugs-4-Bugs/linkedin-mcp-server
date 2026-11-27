# Progress Tracker

**Project status: PHASE 0 APPROVED / MILESTONE 1 (FOUNDATION) COMPLETE & VERIFIED.**
**Next: Milestone 2 — LinkedIn OAuth connection, encrypted token vault, lifecycle (blocked on owner creating the LinkedIn developer app).**

## Log

| Date | Task | Status | Evidence | Notes |
|---|---|---|---|---|
| 2026-11-26 | Read full blueprint (89 files) | DONE | this session | conflict D-001 recorded (uploaded master prompt > zip variant) |
| 2026-11-26 | T0.1 repo/environment audit | DONE | PHASE_0_REPORT.md §1 | greenfield repo `main`@97daf6d, no remote; Node v24.22.3, npm 11.19.1; no existing code/tests |
| 2026-11-26 | T0.2 LinkedIn API research | DONE | PHASE_0_REPORT.md §2 | official sources only (Microsoft Learn 2026-10-19/2026-06-03/2026-05-15/2026-02-02; LinkedIn legal terms) |
| 2026-11-26 | T0.3 Claude/ChatGPT/MCP research | DONE | PHASE_0_REPORT.md §3 | Claude support.claude.com; ChatGPT help.openai.com; npm registry checked 2026-11-26; live client tests deferred to T4.1/T4.2 |
| 2026-11-26 | T0.4 architecture/hosting proposal | DONE — owner approved | owner message (D-A1…D-A10); IMPL_PLAN.md | ADRs 005–012 accepted as baseline; hosting/cost doc due at M5 |
| 2026-11-26 | Memory/task files updated | DONE | memory/*, TASKS.md | — |
| 2026-11-26 | Condition-10 baseline updates | DONE | IMPL_PLAN.md, ADR-005…012, DECISIONS D-A1…D-A10 | pinned dep versions, environments, security design, milestones |
| 2026-11-26 | SDK v2 API surface verification | DONE (exploratory) | in-memory client→server: listTools/callTool OK; errors: bad args = isError content, unknown tool = -32602 | `callTool(params-object form)`; modern envelope needs `_meta` namespaced keys + `Mcp-Method`/`Mcp-Name` headers |
| 2026-11-26 | M1 foundation code | DONE | src/ (config, logger, toolPolicy, serverFactory, stdio+http entries) | TS strict flags: noUncheckedIndexedAccess, exactOptionalPropertyTypes |
| 2026-11-26 | T1.1 + T1.2 | DONE | `npm run verify` full pipeline | **Commands + observed results:** typecheck ✅ · lint ✅ · build ✅ · vitest **26/26 tests, 5 files** ✅ · `npm audit` (all deps) **0 vulnerabilities** ✅ · secret-scan **clean** ✅ |
| 2026-11-26 | **M1 verification gate** (owner-ordered) | DONE | git + probes + re-run pipeline | branch `main`, HEAD `c94ee37`, parent `f601063`, clean tree; c94ee37 in history w/ 113 files; loopback refusal + stdout wire purity probed; **findings fixed:** HIGH unbounded body buffering → 4 MiB cap + 413, `/mcp` prefix-squat → exact match; suite **31/31, 6 files**; audit 0/0; scan clean |
| 2026-11-26 | **M2 OAuth foundation** (mock-driven per owner directive) | DONE | full pipeline, see below | state store + AES-256-GCM vault + mock/real providers + connection service + 3 tools + OAuth routes; redaction extended to state/code; **75/75 tests, 10 files**; audit 0/0; scan clean |
| 2026-11-26 | **M3 profile + granted-scope verification** (mock/fixtures) | DONE | full pipeline, see below | get_my_profile via OIDC userinfo (strict allowlist, timeout, 401 mapping) + scope truth model tool + ADR-013/014; **109/109 tests, 13 files**; regression probes on bridge/callback green; audit 0/0; scan clean |

## M1 verification evidence (2026-11-26, observed output)

- `npm run typecheck` → exit 0, no errors.
- `npm run lint` → exit 0, no findings (eslint 10.15.0 + typescript-eslint 8.74.0 strictTypeChecked/stylisticTypeChecked).
- `npm run build` → dist/ emitted (config, mcp/transport entries, observability, policy).
- `npx vitest run` → "Test Files 5 passed (5) / Tests 26 passed (26)".
- `npm audit --omit=dev` and `npm audit` → "found 0 vulnerabilities".
- `npm run scan:secrets` → "secret scan clean".
- Manual transport E2E before codifying: stdio child process round-trip (`STDIO E2E OK`), HTTP loopback `tools/call` → 200 + structured status JSON.

## M1 verification gate evidence (2026-11-26, observed output)

- Git: `git branch --show-current` → `main`; `git rev-parse HEAD` → `c94ee37bafb088eb5a36bc604712083704c78c5f` (parent `f601063c…`); `git status --short` → empty (clean); `git merge-base --is-ancestor c94ee37 HEAD` → YES; `git ls-tree -r c94ee37` → 113 blueprint files, src/ + tests/ all present.
- Behavioral probes: local+0.0.0.0 → process exit 1, `HTTP_HOST: local environment must bind loopback` BEFORE listening; staging+0.0.0.0 → listen succeeds; raw stdio wire probe → `stdout lines=3 non-framing=0 STDOUT-WIRE-PURE`.
- Gate fixes (items 6+7): HTTP bridge body cap 4 MiB + 413 (was unbounded buffering — HIGH); exact `/mcp` route match (was prefix-squat); new `tests/security/gate-regressions.test.ts` (5 tests: loopback exit, parseConfig both envs, wire purity, 413, route exactness incl. `/mcp?query` → 405).
- Final gate pipeline: typecheck ✅ · lint ✅ · build ✅ · vitest **31/31 tests, 6 files** ✅ · npm audit 0 vulns (all+prod) ✅ · secret scan clean ✅.

## M2 verification evidence (2026-11-26, observed output)

- `npm run typecheck` → exit 0; `npx eslint .` → exit 0, no findings; `npm run build` → dist/ emitted incl. `src/auth/linkedin/*`, `src/tools/*`, `src/identity/*`, `src/usage/*`.
- `npx vitest run` → "Test Files 10 passed (10) / Tests 75 passed (75)" — including: OAuth state store (6: single-use, TTL, tenant-bound, forged), vault (6: seal/unseal, tenant isolation, ciphertext canary, key validation), bucket (2), authorize gate (4), connection service (14: full happy path, forged state, replay, expired tokens, rate limit per-tenant, disconnect), real provider w/ injected fetch (5: URL shape, token exchange, error mapping without body leak, network, malformed), **mock 3LO E2E over compiled HTTP entry (6: connect→consent→callback→connected, confirmation gate, forged 400, replay 400, 429 rate limit)**, secret hygiene (4).
- Security fix found BY tests: logger redaction now covers `state`/`code` keys (was missing; caught by oauth-hygiene canary test).
- `npm audit` + `--omit=dev` → 0 vulnerabilities; `npm run scan:secrets` → clean; `npm ls --depth=0` → exact pinned versions (no dep changes).
- Directives honored: no scope expansion; no pinned-dep changes; M3 not started.

## M3 verification evidence (2026-11-26, observed output)

- Baseline before implementation: branch `main`, HEAD `a5fcd78` (parent `4e7f7d2`), clean tree; both commits ancestors of HEAD; suite re-run 75/75 green.
- `npm run typecheck` → exit 0; `npx eslint .` → exit 0, no findings; `npm run build` → exit 0.
- `npx vitest run` → "Test Files 13 passed (13) / Tests 109 passed (109)": +34 new M3 tests — userinfo schema (7: object/shape/unexpected-field/wrong-type/localized-variant rejections, minimal-accept), scope truth model (6: unverified/partial/disconnected/expired/foreign-claim), profile security matrix (17: happy path, disconnected-no-provider-call, expired-vs-not-connected distinction, missing scope, cross-tenant, no-args-schema forgery impossible, 401 no-leak, unexpected-field no-echo, non-JSON, timeout <2s, network, token non-leakage, 10-way concurrency, mock foreign-token 401, self-checking mock fixture), HTTP E2E profile flow (5: pre-connect not-connected, connect→consent→callback→profile, scope tool honest state, schema rejects memberId impersonation, disconnect resets both tools).
- Security fix during M3: profile tool now distinguishes expired (code `expired`, reconnect guidance) from never-connected (`not-connected`) — previously conflated; tool time made injectable for deterministic tests.
- Regression probes (observed): forged callback state → 400 `unknown state parameter`; 5 MiB body → 413; `/mcpfoo` → 404; POST on GET-only OAuth route → 405. No bridge/callback regressions from M3.
- `npm audit` (+ `--omit=dev`) → 0 vulnerabilities; pinned deps unchanged.
- **Post-commit security finding & fix (2026-11-26):** the secret scan was re-run against the COMMITTED tree and FAILED — the M3 test fixture string a foreign-token fixture shaped like a LinkedIn token literal matched the LinkedIn token pattern, and the pre-commit "clean" had been a false negative because the scanner only read `git ls-files` (tracked files), missing not-yet-staged new test files. Fixes: (1) the foreign-token test fixture is now assembled at runtime (no literal pattern hit); (2) `scripts/secret-scan.sh` now scans tracked AND untracked-but-present files (`git ls-files --cached --others --exclude-standard`). Full pipeline re-run green: typecheck 0, lint 0, build 0, 109/109 tests, audit 0/0, **scan clean on the working tree including all new files**. Finding folded into the M3 amend.
- LIVE LinkedIn validation NOT performed (no credentials — owner action pending, non-blocking).

## M4 verification evidence (2026-11-27, observed output)

- Baseline before implementation: branch `main`, HEAD `f753119` (parent `a5fcd78`), clean tree (after `git config core.fileMode false` — sandbox had flipped permission bits only); M1/M2/M3 commits all ancestors of HEAD. Environment restored after sandbox recycle: `npm ci` (pinned lockfile) + rebuild; suite re-run 109/109 green before any M4 change.
- `npm run typecheck` → exit 0; `npx eslint .` → exit 0, 0 findings; `npm run build` → exit 0.
- `npx vitest run` → "Test Files 16 passed (16) / Tests 165 passed (165)": +56 new M4 tests — publish tool behavior (33: text validation incl. 3000-char/blank/control-chars; draft/preview; confirm gate schema rejections (false/missing); success with URN + ledger success; 4xx refusal; timeout→ambiguous never auto-retried; ambiguous blocks identical resubmit; 503 ambiguous; bad-URN 201 invalid-response; duplicate-recent-identical; different-content publishes; daily budget exhaustion; invalid content never sent; not-connected/insufficient-scopes/expired/cross-tenant/identity-unresolved refusals; real-provider request shape via injected fetch — endpoint/headers/body/URN/403/503/no-body-echo), publish security matrix (17: disconnected, expired, missing scope, forged author impossible, cross-tenant, confirm bypass attempts, token non-leakage in responses/errors/logs + redaction filter, in-flight lock single submission, concurrent different content, mock foreign-token 401, mock author/token binding 422, config cannot bypass authorization), HTTP E2E full flow (6: pre-connect refusal, protocol-level confirm:false rejection, connect→consent→callback→draft→preview→publish→duplicate-refused→second-publish, author forgery rejected at schema boundary, 4000-char refused, disconnect resets).
- Security findings during M4, fixed: (1) mock provider used `Date.now()` directly — non-deterministic expiry against injected clocks; now injectable. (2) the new security test carried a token-shaped literal — caught by the (M3-fixed) scanner covering untracked files; de-literalized at runtime.
- Regressions: 109 M1–M3 tests all green (catalog assertions extended to the 10-tool catalog; profile-security test rig updated for new ToolContext fields; `mintedCount` test hook accidentally dropped during the mock edit — restored).
- `npm audit` (+ `--omit=dev`) → 0 vulnerabilities; `npm run scan:secrets` → clean (tracked + untracked); `npm ls --depth=0` → exact pinned versions unchanged.
- LIVE publishing NOT performed (no app credentials — owner-gated). `urn:li:person:{sub}` author mapping is community-verified, flagged for live confirmation (ADR-017).

## M5 verification evidence (2026-11-27, observed output)

- Phase 0/1: remote verified (Hugs-4-Bugs/linkedin-mcp-server); origin/develop was a single unrelated LICENSE commit (63095f2) — reconciled non-destructively via unrelated-history merge from M4 (45dd946) → 8212a5a pushed to develop BEFORE any M5 code. main stayed 85e6683 (checked before and after). Secret safety swept pre-push: tree + full history clean.
- `npm run typecheck` → exit 0; `npx eslint .` → 0 errors; `npm run build` → exit 0.
- `npx vitest run` → "Test Files 18 passed (18) / Tests 212 passed (212)": +47 M5 tests — DB persistence on-disk SQLite (25: migrations idempotent, vault round-trip/ciphertext-only/tenant isolation/delete semantics, state store tenant-bound/replay/expired/atomic single-use, ledger enter/exit/duplicate/in-flight/ambiguous-suspect, budget transactional + restart survival, sessions lifecycle/expiry/digests, API tokens, audit, with() rollback) — remote-security E2E over the compiled entry in persistence mode (21: 401 unauthenticated, forged tenant header inert, uniform login errors, security headers, CSP-safe admin page, OAuth routes auth-gated + bounded redirect, logout CSRF + revocation, 413 cap, publish confirm-gate through protocol, cross-tenant isolation, bearer token lifecycle, invalid bearer 401, rate-limit 429) — config fail-fast (production rejects mock auth/OAuth/missing DB/missing key).
- Bugs found BY our tests and fixed during M5: (1) MCP SDK lazy factory escaped the request ALS scope → tool contexts now per-call; (2) OAuth route hand-rolled tenant split the vault key space (userId mismatch); (3) SQLite positional-? translation mis-bound out-of-order placeholders → numbered ?N; (4) 413 surfaced as 500 on login; (5) migration bootstrap queried schema_migrations before creating it.
- `npm audit` (+ `--omit=dev`) → 0 vulnerabilities; secret scan → clean; deps: +pg@8.16.0 (runtime, justified by M5 persistence requirement), +@types/pg@8.15.6 (dev); all other pins unchanged.
- Deployment stack (deploy/) NOT live-hosted: runbook + compose verified to the extent the sandbox allows (bootstrapAdmin smoke-run against SQLite, healthz, graceful shutdown). Postgres executor shares the exact SQL surface with the SQLite-verified stores; a live Postgres bring-up remains part of the first staging deploy (owner manual action).

Update after every task with date, commit, status, test evidence, blockers and next task.
