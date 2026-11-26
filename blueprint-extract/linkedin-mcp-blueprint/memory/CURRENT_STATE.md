# Current State

**2026-11-26 — MILESTONE 2 (LinkedIn OAuth foundation, mock-driven) COMPLETE & VERIFIED. Next: Milestone 3 (read tools).**

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
