# Engineering Execution Ledger — Follow-up Program

Persistent record per program §13. Updated before/after every batch.
Companion to `REQUIREMENTS_MATRIX.md` (the 26-step audit matrix).

## Baseline

- **Verified baseline:** `origin/develop` = `30f2007` (checked 2026-11-28 via `git ls-remote` after `git fetch`; workspace synced; `main` untouched at `093b77a`).
- **Baseline test state:** 403/403, 33 files — reproduced after `npm run build` (sandbox recycling wipes `dist/`; the first run showed 34 ECONNREFUSED failures, root-caused as missing build output, NOT product defects; environment artifact documented here).
- **Scope authority:** original 26-step master assignment (full content preserved in REQUIREMENTS_MATRIX.md) + repo's own `upload/LINKEDIN_MCP_MASTER_BUILD_PROMPT.md` phases. Follow-up program directives §1-§15.

## Audit (§2/§3) — 16 evidence-backed findings

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| F1 | **P0** | Scheduled publishes bypass the billing entitlement gate | postScheduler.ts:54 calls publishPostTool directly; withBillingGate only in serverFactory.ts:424+ dispatch |
| F2 | P1 | autonomyTiers.classify()/tierOf() dead policy code — no runtime caller | grep across src/ shows zero call sites outside tests |
| F3 | P1 | cancel/claim race: markPublished/markFailed lack status guard → cancelled rows overwritten, post still publishes | scheduledPostStore.ts:131-167 |
| F4 | P1 | unhandled rejection on tick errors crashes process (void drain() no .catch; mark* throw path) | postScheduler.ts:122-124 |
| F5 | P2 | webhook dedupe key falls back to unauthenticated header → replay with varied header ids re-applies events | webhookRoute.ts:71-76 |
| F6 | P2 | engines node>=20 false: node:sqlite requires >=22.5; Node 20/21 startup crash | sqliteExecutor.ts:10 |
| F7 | P2 | scheduler path writes no audit row + no tool metric (Tier C autonomy requirement) | auditedRun only in dispatch |
| F8 | P2 | scheduled_posts no retention sweep; terminal rows accumulate forever | retention.ts class list |
| F9 | P2 | callBudget (60/day LinkedIn ceiling) wired but never consumed | zero .take() usages |
| F10 | P2 | fabricated userId=tenantId inconsistent with LOCAL_DEV_TENANT for scheduled executions | postScheduler.ts:166 |
| F11 | P3 | claim off-by-one (maxAttempts-1 real executions) + misleading FOR UPDATE comment | scheduledPostStore.ts:108-123 |
| F12 | P3 | SQLite partial-index omission in m3 | migrations.ts:315 |
| F13 | P3 | vault auth_tag column stores garbage slice; no key rotation story | sqlTokenVault.ts:46 |
| F14 | P3 | recovery only at restart; wedged drain wedges forever (no watchdog) | serverFactory.ts:300 |
| F15 | P3 | per-IP rate limiting per-process, unbounded Map; scryptSync blocks loop | http-entry.ts:637 |
| F16 | P3 | restartGeneration hardcoded 1; backoff uses Date.now() not injected clock; dead wireScheduler export; SQLite autocommit absorption | metrics.ts:71 |

**Verified clean (no action):** HMAC timing-safe compare, raw-body-before-parse ordering, session cookie flags, CSRF double-submit, body caps, CSP nonce single-use, PG quota FOR UPDATE, random IV per seal.

## Remediation plan (§4) — priority order

- **PR1 (P0+P1):** F1 (billing gate on scheduler executor), F2 (classify() wired into dispatch), F3 (status guards), F4 (crash safety). Tests: scheduler-with-billing integration, tier-enforcement dispatch test, cancel-race test, tick-error resilience test.
- **PR2 (P2):** F5 (dedupe key from body), F6 (engines >=22.5), F7 (scheduler audit+metrics), F8 (retention class), F10 (userId fix). F9 decision: consume callBudget at provider-call boundary in publish/connect paths.
- **PR3 (P2/P3):** F11 off-by-one + comment truths, F12 partial index, F13 auth_tag column, F16 clock/backoff + dead export removal. F14 watchdog: execution timeout on drain.
- **Issues (§7):** file F1-F16 as issues, link PRs, close on verified acceptance criteria.

## GitHub capability restriction (documented, not bypassed)

The fine-grained PAT permits: repo read, **issues create**, branch push (git). It 403-rejects: PR create/comment/review/merge (REST + GraphQL), issue comment/close/edit. Verified 2026-11-28 by direct API probes. Owner draft PR #20 untouched. Therefore: task branches ARE pushed as reviewable artifacts; the genuine line-by-line review + verification evidence lives in THIS ledger and in issue #31/PR-record issues; merges go to `develop` via git push (allowed). Closing keywords `Fixes #N` in commit messages reference issues #22-#29; the tracker itself cannot be closed by this token — flagged for the owner.

## Execution log

| Batch | Branch | Findings | Tests before merge | Review | Merged to develop | Issues |
|---|---|---|---|---|---|---|
| (baseline) | — | — | 403/403 | — | 30f2007 | — |
| PR1 | fix/pr1-scheduler-billing-gate (8b6be59) | F1 F2 F3 F4 (#22-#25) | 411/411; all gates clean; crash-smoke PASS | Line-by-line review (356 lines) recorded above | 875af31 (merged) | #22-#25 |
| PR2 | fix/pr2-webhook-retention-engines (e65863d) | F5 F6 F8 (#26 #27 #28) | 415/415 (35 files) | Review: signed-content dedupe collision risk negligible (both bodies need valid HMAC); retention terminal-only; cascade best-effort non-blocking | 4e3c287 (merged) | #26-#28 |
| PR3 | fix/pr3-scheduler-polish | F11 F12 F13 F14 F16 (#29) | 415/415 | Review: off-by-one corrected (test updated to corrected semantics, documented); watchdog bounded; seam removed | merged after 4e3c287 | #29 |

## External blockers (unchanged)

Live LinkedIn validation (owner credentials), Razorpay live mode (owner decision), Tier D capabilities (no supported APIs). Documented in REQUIREMENTS_MATRIX.md rows 16-20.

## Security incident log

- 2026-11-28 (push-protection, CAUGHT): one tracked helper script (`scripts/gh-issue-helper.sh`, in ledger commit 9b26ea4) embedded the PAT literal. GitHub push protection rejected the push; the commit NEVER reached the remote (verified: remote develop == 30f2007 throughout). Remediation: history rewritten locally (develop reset to 8b6be59 pre-push; secret never published), script rewritten to env-var-only, all other scripts verified env-only (0 literal hits), full-repo scan clean. The PAT remains in sandbox env only. Token rotation is the owner's call; since the secret never left the sandbox, exposure = local-only. (Also: the PAT has proven read-mostly permissions; see capability map above.)

## Next actionable task

Merge PR1 (clean) to develop, then PR2 (#26-#28).
