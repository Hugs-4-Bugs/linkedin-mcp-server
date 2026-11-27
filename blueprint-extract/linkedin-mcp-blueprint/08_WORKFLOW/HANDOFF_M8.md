# Milestone 8 Handoff Report — Release Engineering & Open Source (Issue #15)

**Date:** 2026-11-27 · **Status:** COMPLETE, all gates green · **Branch:** `develop` · **Boundary:** stopped at M8; M9 NOT started.

## 0. Scope correction (verified from live GitHub — read before reviewing)

The task prompt proposed M8 = issues #13 (payment/webhook) + #14 (hosted entitlements). **That mapping is wrong and was not implemented.** Verified live from the GitHub API:

- Issues **#13 and #14 are in milestone "M9 — Hosted SaaS & Monetization"** (#6). Issue #13's body begins *"Future: …"*; the repo's committed `roadmap/ROADMAP_RECONCILIATION_M6.md` records M9 as *"FUTURE (post-M8; roadmap Phase 8, separately owner-approved). … Explicitly out of M1–M8 execution scope."* The live GitHub milestone state matches that record.
- **The actual M8 milestone (#2, "Release Engineering & Open Source") contains exactly one issue: #15 — AGPL open-source release checklist** ("Verify license, notices, contributor guide, code of conduct, security policy, privacy documentation and release checklist").
- The prompt's own rules (issue-driven; "do not assume the mapping from this prompt"; "Stop at M8. Do not start M9"; never silently modify the roadmap) therefore make **#15 the only legitimate M8 implementation**. Billing/payment/entitlement code was **not started**; the billing design questions in the prompt remain unanswered-by-code on purpose, and are recorded as M9 inputs in §13.

## 1. Baseline verification (Phase 0)

Sandbox recycled again (checkout was `main`@M4-era); `develop` ref survived. Restored: HEAD `6922cb3` = reported M7 final = live `origin/develop` (verified via `ls-remote`); tree `3e90016`; parent `612e7ff` (M7 lineage intact). Remote `main` = `85e66838…` untouched. Working tree clean; deps intact; dist rebuilt; **266/266 re-verified green + secret scan clean before any M8 work**.

## 2–3. Verified issue #15 contents + milestone mapping

From the API: #15 "AGPL open-source release checklist" · open · milestone M8 — Release Engineering & Open Source (#2, description "AGPL, governance, CI, packaging and release process") · labels `type: documentation / priority: high / area: devops` · no assignee · no comments. Body: *"Verify license, notices, contributor guide, code of conduct, security policy, privacy documentation and release checklist."* These seven items were implemented 1:1 (below). No acceptance criteria invented.

## 4. Implementation plan (as executed)

1. Licensing: LICENSE + NOTICE + package.json license/version/metadata + server version sync.
2. Governance: CONTRIBUTING, CODE_OF_CONDUCT, expanded SECURITY_POLICY, CHANGELOG, RELEASE_CHECKLIST, README links.
3. CI: `.github/workflows/ci.yml` (same gates a human runs).
4. Enforcement: `tests/security/release-checklist.test.ts` — the checklist automated as a regression gate.

## 5. Release engineering delivered (mapped to the issue's seven items)

| Issue item | Delivered |
|---|---|
| license | `LICENSE` = full canonical AGPL-3.0 text (SPDX-list verbatim copy; 34,020 chars; §13 present); `package.json` `license: AGPL-3.0-or-later`; version `0.8.0`; `private: true` kept until owner publish |
| notices | `NOTICE` (copyright 2026, AGPL reference, runtime components MIT, MPL-2.0 note, census pointer) |
| contributor guide | `CONTRIBUTING.md` (dev env; gates incl. secret-scan hard gate; DCO `Signed-off-by`; AGPL contribution terms; security-PR review rules) |
| code of conduct | `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, enforcement contact cross-linked to security policy) |
| security policy | `03_SECURITY/SECURITY_POLICY.md` rewritten: private channel via GitHub security advisories (explicit "do not open a public issue"), 72h ack/7d triage SLA, scope, safe-harbor, posture rules |
| privacy documentation | already delivered in M7 (DATA_PRIVACY.md); now linked from README + verified non-stub by the new test (retention classes, deletion semantics) |
| release checklist | `RELEASE_CHECKLIST.md` (license/quality/docs gates, signed tag + checksums, AGPL §13 hosted source-offer, post-release) + CHANGELOG 0.1.0→0.8.0 |

## 6–8. Tests / pipeline / scans (executed on committed HEAD `cad8a09`)

- **278/278 tests** (24 files): baseline 266 + **12 new** release-checklist tests. 0 failures, 0 skipped. One existing expectation updated for the intentional version bump (`SERVER_VERSION` default 0.1.0→0.8.0) — a legitimate default change, not a weakening; all other 266 untouched.
- typecheck **0** · eslint **0 errors** · build **0** · `npm audit` 0 (all + `--omit=dev`) · secret scan **clean** · no secrets in any commit (verified per-commit).
- Real-PG suite included in the 278 (17/17, embedded-postgres 19).

## 9. Dependency changes

**None.** No runtime/dev packages added or upgraded; only metadata fields. License census of all 220 locked entries: MIT 172, Apache-2.0 18, MPL-2.0 12, ISC 8, BSD-2-Clause 6, BlueOak 2, BSD-3-Clause 2 — all AGPL-compatible; enforced by the new census test (unknown/missing license = FAIL).

## 10. Commits (all on develop; SHAs + lineage)

| SHA | Batch | Parent |
|---|---|---|
| `da8c0fdb5756f8b0b16b4977c683169857ff6500` | licensing + metadata (LICENSE/NOTICE/package.json/version) | `6922cb3` (M7) |
| `93d159322078d399f9a4f3e037c625bcb4676fc5` | governance docs + CI workflow | `da8c0fd` |
| `cad8a09446574fbaa2b7cd0ddbf590fa3bb4d5c2` | release-checklist regression tests (12) | `93d1593` |

Each verified after commit: SHA, parent, tree stats, files included, no secrets, clean tree.

## 11. Push + remote verification

Pushed `6922cb3..<HEAD>` to `origin/develop` (see final check below). Remote `main` = `85e66838…` untouched before/during/after. No force-push, no history rewrite, nothing closed/assigned/merged; only `Refs #15` references.

## 12. PR status

**No PR exists — creation verified blocked again**: `POST /pulls` → 403 "Resource not accessible by personal access token" (fine-grained PAT grants Contents:write only; issue/PR writes are read-only — same limitation as M6/M7). Owner steps for a PR record (commits are already on develop):
`git checkout -b m8-release-engineering cad8a09 && git push origin m8-release-engineering` then open PR `m8-release-engineering` → `develop` on GitHub, body: "Refs #15 — 3 commits da8c0fd/93d1593/cad8a09; 278/278 tests; audit 0; scan clean."

## 13. What was deliberately NOT done (billing scope — recorded for M9, not decided here)

- No payment provider was selected or integrated (issue #13 = M9). Per the prompt's Phase 2: no provider can be assumed; that evaluation belongs to M9 with owner approval, informed by the repo's `area: billing` issues. No merchant accounts, live credentials, charges, or webhooks exist in this milestone.
- No entitlement/usage-limit code (issue #14 = M9). The existing per-tenant publish budget + call budget remain the enforcement mechanism.
- Design considerations the prompt lists (webhook signature/replay/idempotency, hosted vs self-hosted entitlement boundary, tenant isolation, concurrency, free/paid tiers) are **valid M9 inputs** and are captured here for the owner; the self-hosting constraint ("self-hosting must not require hosted payment") is already reflected in the repo posture (D-A6 private pilot) and will gate any M9 design.

## 14. Remaining owner actions

1. Review the 3 commits on `develop` and merge when satisfied.
2. Optional PR record per §12.
3. Decide publish timing: flip `package.json` `private` to `false` (or remove) at first public release per RELEASE_CHECKLIST §1, and set the CODE_OF_CONDUCT contact placeholder (currently cross-references SECURITY.md) to a real email if preferred.
4. Enable GitHub security advisories + tag protection on the repo (settings UI — API-blocked for the agent).
5. M9 (issues #13/#14) requires explicit owner approval before any billing code lands — per the roadmap record.
6. CI first run will need `workflow` scope approval (Actions) when you connect the repo's GitHub Actions (the workflow file is committed; runs start once enabled).

## 15. Completion recommendation

**M8 should be considered technically complete for issue #15.** All seven checklist items the issue names are implemented and *enforced by automated tests* (12 new; full suite 278/278; pipeline green; zero dependency changes; audit/scan clean; commits mapped and verified; roadmap untouched; M9 deliberately not started). The only open items are owner-side publish decisions (§14), not implementation gaps.
