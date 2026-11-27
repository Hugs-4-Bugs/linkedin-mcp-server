# Roadmap Reconciliation M6 (2026-11-27)

**Status: NOT APPLIED via GitHub API** — the provided fine-grained PAT grants
repository **Contents:write only** (verified: `git push` to develop works; every
issues/milestones/pulls/comments write returns 403 "Resource not accessible by
personal access token"). Per the owner's instruction to report the limitation
rather than falsely claim updates, the complete intended changes are recorded
here for one-shot application by the owner (UI or a token with Issues+Milestones write).

## Constraints honored
- No milestones deleted; no milestones closed; no issues closed; no assignment changes.
- The 10-milestone structure is PRESERVED and now explicitly mapped onto the 7
  execution milestones (M1..M8 execution = GH M1..M8; GH M9/M10 = post-M8 future scope).

## Mapping summary
| GH milestone | Execution milestone | Status |
|---|---|---|
| M1 Foundation | M1 | implemented + verified (c94ee37, 4e7f7d2) |
| M2 OAuth | M2 | implemented + verified (a5fcd78); live validation owner-side (#3) |
| M3 Profile | M3 | implemented + verified (f753119); live validation owner-side (#1) |
| M4 Publishing | M4 | implemented + verified (45dd946); live LinkedIn credentials pending |
| M5 Persistence | M5 | implemented + verified (9db2685); live PG tests land in M6 (#6) |
| M6 Claude/ChatGPT | M6 (Phases 4+6) | IN PROGRESS (this milestone: #11, #9, #10) |
| M7 Hardening | M7 | future (audit pass) |
| M8 Release | M8 | future (sign-off + AGPL release) |
| M9 SaaS | post-M8 Phase 8 | future, owner-approved separately |
| M10 Scale | post-M8 | future |

## Machine-applyable JSON

```json
{
 "generated": "2026-11-27",
 "reason": "Fine-grained PAT grants Contents:write only (verified: push works; issues/milestones/pulls/comments API writes return 403 'Resource not accessible by personal access token'). This file records the intended roadmap reconciliation so the owner (or a token with Issues/Milestones write) can apply it verbatim.",
 "constraints": [
  "no milestone deletions",
  "no milestone closes",
  "no issue closes",
  "no assignment changes"
 ],
 "milestones": [
  {
   "number": 1,
   "title": "M1 \u2014 Foundation & MCP Infrastructure",
   "description": "IMPLEMENTED & VERIFIED 2026-11-26..27 (execution milestone M1; commits c94ee37, 4e7f7d2 on develop). Server skeleton (stdio + Streamable HTTP), strict TS, zod config validation, redacting logger, loopback + body-cap transport tests. Open item #2 = independent reproduction of the M1 baseline (owner-side verification). Evidence: 08_WORKFLOW/HANDOFF_M1.md."
  },
  {
   "number": 9,
   "title": "M2 \u2014 LinkedIn OAuth & Connection Lifecycle",
   "description": "IMPLEMENTED & VERIFIED 2026-11-26 (execution milestone M2; commit a5fcd78 on develop). 3LO providers (mock+real), CSRF state store, AES-256-GCM vault, connection tools w/ confirmation gate, OAuth routes. Open item #3 = LIVE LinkedIn app validation (owner-created app; redirect URI; replay protection vs the real provider). Evidence: 08_WORKFLOW/HANDOFF_M2.md."
  },
  {
   "number": 10,
   "title": "M3 \u2014 Member Profile & Scope Transparency",
   "description": "IMPLEMENTED & VERIFIED 2026-11-27 (execution milestone M3; commit f753119 on develop). get_my_profile (OIDC userinfo, strict allowlist, 401/timeout), granted-scope truth model, ADR-013/014. Open item #1 = LIVE userinfo validation with an authorized account. Evidence: 08_WORKFLOW/HANDOFF_M3.md."
  },
  {
   "number": 8,
   "title": "M4 \u2014 Publishing & Write Safety",
   "description": "IMPLEMENTED & VERIFIED 2026-11-27 (execution milestone M4; commit 45dd946 on develop). draft/preview/publish tools (Posts API verified contract, confirm:true schema gate, memberSub authorship), write-safety op ledger (in-flight lock, duplicate window, ambiguous-suspect, no auto-retry), app-level safety limits (ADR-015/016/017). Live publishing awaits owner LinkedIn credentials (same blocker as #1/#3). Evidence: 08_WORKFLOW/HANDOFF_M4.md."
  },
  {
   "number": 4,
   "title": "M5 \u2014 Persistence & Production Infrastructure",
   "description": "IMPLEMENTED & VERIFIED 2026-11-27 (execution M5 + remote-security foundation; commit 9db2685 on develop). SQL executor seam (PostgreSQL pg@8.16.0 + SQLite node:sqlite), idempotent migrations, ciphertext-only vault, persistent state/ledger/budgets, scrypt users + digest-at-rest sessions/CSRF/bearer, credential-derived tenants (ALS), production fail-fast, /admin console, deploy/ stack. Open: #6 (live Postgres integration tests \u2014 landing in M6) and #5 (isolation tests \u2014 implemented in the 212-test suite; re-verify on live staging). Evidence: 08_WORKFLOW/HANDOFF_M5.md."
  },
  {
   "number": 3,
   "title": "M6 \u2014 Claude & ChatGPT Integration",
   "description": "IN PROGRESS 2026-11-27 (execution milestone M6 = client compatibility + staging foundation; roadmap Phases 4+6). Scope per owner M6 brief: (a) #11 staging deployment foundation \u2014 PostgreSQL 17 integration (real server), preflight checks, smoke tests, docker/compose validation, backup/recovery instructions; (b) #9 Claude connector compatibility \u2014 protocol-level deterministic tests + current official setup docs + troubleshooting + live checklist; (c) #10 ChatGPT connector compatibility \u2014 same. Live connector tests (real Claude/ChatGPT apps against a public HTTPS host) remain owner-side; automated tests verify the protocol surface those clients exercise."
  },
  {
   "number": 5,
   "title": "M7 \u2014 Security Hardening & Compliance",
   "description": "FUTURE (execution M7 = roadmap Phase 5 + Phase 7 audit). Threat-model tests (#12), retention enforcement + deletion verification (#16). M5 landed the security foundation (auth, tenant isolation, headers/rate/413, fail-fast); this milestone is the independent audit pass on top."
  },
  {
   "number": 2,
   "title": "M8 \u2014 Release Engineering & Open Source",
   "description": "FUTURE (execution M8 = production sign-off + release). AGPL release checklist (#15), CI/CD, packaging. Do not start before M7 sign-off (owner decision D-A9: private-pilot posture)."
  },
  {
   "number": 6,
   "title": "M9 \u2014 Hosted SaaS & Monetization",
   "description": "FUTURE (post-M8; roadmap Phase 8, separately owner-approved). Paid entitlements (#14), payment verification + webhook security (#13). Explicitly out of M1\u2013M8 execution scope."
  },
  {
   "number": 7,
   "title": "M10 \u2014 Scale & Operations",
   "description": "FUTURE (post-M8). Observability, incident response, performance, resilience (#17). M5 landed healthz + graceful shutdown + logging foundations; the full operational pass happens after production sign-off."
  }
 ],
 "issues": [
  {
   "number": 11,
   "title": "Remote MCP HTTPS deployment",
   "body": "### M6 scope (owner brief, 2026-11-27)\n\nReview + validate the M5 deployment foundation; implement/fix only what is required for:\n\n- PostgreSQL 17 staging integration (REAL server tests, not SQLite-only)\n- Docker Compose deployment validation; Caddy/HTTPS readiness\n- Environment configuration validation; secrets management\n- Bootstrap process (bootstrapAdmin), health checks, graceful shutdown\n- Migration execution; deployment preflight checks\n- Authentication/authorization + tenant isolation on staging\n- Secure configuration defaults; staging smoke tests\n- Backup and recovery instructions\n\nConstraint: no production deploy, no paid infrastructure, no owner-required hosts/domains/LinkedIn credentials available in the sandbox \u2192 deterministic tests + documented owner actions wherever live infra is unavailable.\n\nStatus evidence: tests/integration/pg-integration.test.ts (real PostgreSQL 19 via embedded-postgres dev-dep), deploy/ stack static validation, staging smoke checklist in deploy/README.md. Live staging bring-up = owner action (deploy/README.md first-run sequence)."
  },
  {
   "number": 9,
   "title": "Claude connector integration validation",
   "body": "### M6 scope (owner brief, 2026-11-27)\n\nDeterministic, protocol-level verification of the remote Streamable HTTP surface Claude connectors exercise:\n\n- MCP initialization handshake (initialize \u2192 initialized)\n- Tool discovery (tools/list)\n- Tool invocation incl. structured errors\n- Authentication rejection (401 unauthenticated; invalid bearer)\n- Session behavior (mcp-session-id issue/reuse/unknown-session resume)\n- Error handling shapes (JSON-RPC error codes; safe messages, no leakage)\n- Reconnect behavior (new session id after server restart)\n\nDeliverables: tests/integration/client-compat-claude.test.ts (automated, deterministic); 05_INTEGRATIONS/CLAUDE_INTEGRATION.md \u2014 current official connector setup (remote Streamable HTTP URL), troubleshooting, live validation checklist (owner-side, needs public HTTPS host + credentials).\n\nEXPLICIT status line: automated protocol tests = run in CI; LIVE Claude connector test = NOT performed in sandbox; owner executes the checklist against the deployed host."
  },
  {
   "number": 10,
   "title": "ChatGPT MCP connector integration validation",
   "body": "### M6 scope (owner brief, 2026-11-27)\n\nDeterministic, protocol-level verification of the remote Streamable HTTP surface ChatGPT MCP connectors exercise (same matrix as #9):\n\n- MCP initialization handshake; tool discovery; tool invocation incl. structured errors\n- Authentication rejection (401; invalid bearer); error handling shapes (JSON-RPC codes; safe messages)\n- Session behavior (issue/reuse/unknown-session); reconnect after restart\n- Supported plan/client limitations documented from official sources only (no invented capabilities)\n\nDeliverables: tests/integration/client-compat-chatgpt.test.ts (automated, deterministic; distinct suite asserting the shared protocol contract + documented client-specific notes); 05_INTEGRATIONS/CHATGPT_INTEGRATION.md \u2014 current official connector setup (remote server URL, developer mode where applicable), plan limitations, troubleshooting, live validation checklist (owner-side).\n\nEXPLICIT status line: automated protocol tests = run in CI; LIVE ChatGPT connector test = NOT performed in sandbox; owner executes the checklist."
  }
 ],
 "apply_hint": "PATCH repos/{owner}/{repo}/milestones/{number} and PATCH repos/{owner}/{repo}/issues/{number} with the JSON in this file; or apply via UI."
}
```
