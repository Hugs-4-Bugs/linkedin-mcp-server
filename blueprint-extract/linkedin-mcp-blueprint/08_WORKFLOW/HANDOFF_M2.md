# Milestone 2 Handoff Report — LinkedIn OAuth Foundation (Mock-Driven)

**Date:** 2026-11-26 · **Phase:** M2 per `08_WORKFLOW/IMPL_PLAN.md` · **Status:** COMPLETE, all gates green · **Directive:** owner-ordered — mock OAuth providers/tests; no credentials required; no scope expansion; no dep changes; no M3; stop at M2 boundary.

## 1. What was delivered (working code)

| Module | Files | Function |
|---|---|---|
| Config | `src/config/config.ts` | `OAUTH_PROVIDER=mock\|linkedin` (linkedin requires the full credential triple — config-enforced); `TOKEN_VAULT_KEY` (base64 32-byte, optional → ephemeral dev key with warn); `OAUTH_STATE_TTL_SECONDS` (30–3600, default 600) |
| Identity | `src/identity/tenant.ts` | `TenantContext` + `tenantKey`; `LOCAL_DEV_TENANT` fixed default; all isolation keys derive from tenant |
| Usage | `src/usage/tokenBucket.ts` | Fixed-window `TokenBucket` + `BucketRegistry`; connect-flow limit 6/10 min/tenant |
| Policy | `src/policy/toolPolicy.ts` | `authorize()` gate (not-connected / insufficient-scopes denials) + `WRITE_CONFIRMED`/`WRITE_DRY_RUN_FIRST` presets. **ToolPolicy is now enforced at registration sites** (M1 gap closed) |
| State store | `src/auth/linkedin/stateStore.ts` | CSRF `state`: 32-byte random, sha-256 constant-time compare, single-use (consumed on failure too), TTL, tenant-bound |
| Token vault | `src/auth/linkedin/tokenVault.ts` | AES-256-GCM envelope sealing; 32-byte key validation; tenant-keyed storage; ciphertext-only at rest (canary-tested) |
| Providers | `provider.ts`, `realProvider.ts`, `mockProvider.ts` | Contract + real 3LO adapter (injected fetch, error mapping, body never leaked) + mock (single-use codes, LinkedIn-shaped URLs) |
| Service | `connectionService.ts` | connect (rate-limited) / handleCallback (state → code → seal) / status (60-day expiry aware) / disconnect |
| Tools | `src/tools/connectionTools.ts` | `linkedin_connect`, `linkedin_status`, `linkedin_disconnect` (`z.literal(true)` confirmation gate) |
| Routes | `src/mcp/transport/http-entry.ts` | `GET /linkedin/connect` (303), `GET /linkedin/callback` (200/400/502 paths), `GET /mock/linkedin/authorize` (mock consent; only when provider=mock) |
| Logging | `src/observability/logger.ts` | Redaction extended to OAuth `state`/`code` keys (gap found by new hygiene tests) |

## 2. Verification evidence (2026-11-26, observed)

```
npm run typecheck   → exit 0
npx eslint .        → exit 0, no findings
npm run build        → exit 0 (dist includes all new modules)
npx vitest run       → Test Files 10 passed (10) · Tests 75 passed (75)
npm audit (+ --omit=dev) → found 0 vulnerabilities (both)
npm run scan:secrets → secret scan clean
npm ls --depth=0     → exactly the pinned versions (unchanged)
```

Test coverage highlights: state store (single-use, TTL, tenant binding, forgery), vault (seal/unseal, tenant isolation, plaintext-canary absence, malformed-key rejection), rate limiter, authorize gate, connection-service lifecycle (happy path, forged state, code replay, token expiry, per-tenant rate limit, disconnect), real-provider behaviors against injected fake fetch (no network), **full mock 3LO E2E over the compiled HTTP entry** (connect route → mock consent → callback → MCP tools see `connected: true` → confirmed disconnect → `connected: false`; forged state 400; replay 400; 429 after 6 starts), and secret-hygiene canaries.

## 3. Security posture at M2 (owner D-A8 mapping)

- OAuth state validation: single-use, TTL, tenant-bound, constant-time digest compare ✅
- Secure token storage: AES-256-GCM at rest; ephemeral dev key explicitly warned; production key via secret manager (staging, M5) ✅
- Tenant isolation: all vault/state/limiter keys tenant-derived ✅
- Tool authorization: `authorize()` enforced in registration sites; scoped tools denied when not connected ✅
- Audit logging: structured, redacted (`state`/`code`/tokens), stderr-only ✅
- Rate limiting: connect-flow token bucket per tenant ✅
- Account disconnection & deletion: `linkedin_disconnect` with confirmation gate; vault delete ✅
- Remaining D-A8 items by design at later milestones: Postgres retention sweep (M5), MCP-side OAuth for remote clients (M5 staging), hosted secret manager (M5).

## 4. Known limitations (explicit, not hidden)

- Mock provider is the default (`OAUTH_PROVIDER=mock`); real LinkedIn flow compiles and is unit-tested against an injected fetch, but has **not** been exercised against the live LinkedIn API (no app credentials — owner action pending, not required by directive).
- `memberId` from the real provider is `pending` until M3's userinfo integration (recorded in code comment).
- In-memory vault/state/buckets reset on restart (intended for local dev; hosted persistence is T2.2/M5 — not claimed complete).
- stdio transport serves the same catalog but OAuth routes are HTTP-only (3LO needs a browser callback URL; documented in tool description).

## 5. Deviations / incidents during M2

- One real security gap found by the new hygiene tests and fixed: logger did not redact `state`/`code` keys. Fixed in `logger.ts`; regression tests cover it.
- No pinned dependency changes; no scope expansion; M3 tools not implemented.

## 6. Owner actions (non-blocking for M3 mock work)

1. LinkedIn developer app (client id/secret via secret manager + HTTPS redirect URI) — needed only when live validation is desired.
2. Hosting/domain decision — needed for M5 staging, TLS 443, redirect URIs, and the cost recommendation doc.

## 7. Next milestone (awaiting owner go-ahead)

M3 — read tools: `get_my_profile` (OIDC userinfo adapter with mock fixtures), granted-scope introspection; mock/fixture-driven tests; live calls only after owner provides the app.
