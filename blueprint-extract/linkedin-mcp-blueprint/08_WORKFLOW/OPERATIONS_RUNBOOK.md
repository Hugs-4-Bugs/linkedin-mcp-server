# Operational Runbook (M10 — Scale & Operations)

**Status:** implemented and verified 2026-11-27 (issue #17 area: observability, operational health, resilience).
**Applies to:** the compiled server (`dist/mcp/transport/http-entry.js`) in both self-hosted and hosted-billing modes.

## 1. Probes

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/healthz` | GET | none | **Liveness** — the process exists and answers. Returns `{ok, backend, env}`. |
| `/ready` | GET | none | **Readiness** — the replica can serve traffic. In-memory mode: always ready. Persistent mode: a bounded `SELECT 1` through the real pool (1s timeout). Failing → **503** + `{ok:false, reason}`. |
| `/metrics` | GET | none | **Prometheus text exposition** (format `text/plain; version=0.0.4`). |

Load balancer wiring: liveness → `/healthz`, readiness → `/ready`, scrape interval 15–30s → `/metrics`.
A replica that fails readiness must leave rotation (the 503 is the signal); it does not need restarting unless liveness also fails.

## 2. Metrics

All metrics are in-process, zero external dependencies (Phase 1 per `02_ARCHITECTURE/SCALABILITY.md` — no collector sidecar).

| Metric | Type | Meaning |
|---|---|---|
| `lkm_http_requests_total{route}` | counter | HTTP requests by fixed route class (`/mcp`, `/auth`, `/admin`, `/healthz`, `/ready`, `/metrics`, `/webhooks`, `/api/billing`, `/linkedin`, `other`). |
| `lkm_http_request_errors_total{route}` | counter | Responses with status ≥ 400. |
| `lkm_http_requests_inflight` | gauge | Requests currently being served. |
| `lkm_mcp_tool_calls_total{tool,outcome}` | counter | MCP tool dispatch outcomes (`ok`/`error`). Bounded: unknown tool names collapse to `other`. |
| `lkm_billing_gate_total{outcome}` | counter | Billing gate decisions: `allowed` / `no-entitlement` / `quota-exceeded`. |
| `lkm_process_uptime_seconds` | gauge | Process uptime. |
| `lkm_process_restart_generation` | counter | Boot generation (1 per process start). |

**Cardinality is bounded by design**: route and tool label sets are fixed in code (`src/observability/metrics.ts`); a hostile client cannot grow the label space. No tenant labels are exported — metrics never carry tenant identity, tokens or payloads.

Stdio mode pays nothing: the registry exists but only the HTTP entry wires it.

## 3. Recommended alert starting points

- Readiness failing (`probe /ready != 200` for 2m) → page DB health first (the probe answer includes `reason`).
- `rate(lkm_http_request_errors_total{route="/mcp"}[5m]) > 0.1` sustained → inspect logs (structured JSON, `scope` field) for the failing route.
- `lkm_http_requests_inflight` monotonic growth → connection leak; restart replica out of rotation.
- Billing enabled AND `rate(lkm_billing_gate_total{outcome="no-entitlement"}[10m])` spikes after a known provider incident → check webhook delivery (Razorpay dashboard) and `/webhooks/razorpay` logs.
- `lkm_process_restart_generation` observed on a new scrape → the process restarted; correlate with deploy or crash.

## 4. Graceful shutdown

SIGTERM/SIGINT → stop accepting → close DB pool → exit 0; hard-exit fallback after 10s. Verified by test (`ops-metrics-ready`, workspace smokes). Deployments should send SIGTERM and wait ≤ 10s before SIGKILL.

## 5. Rate limits, body caps, security headers

Per-IP token bucket (`HTTP_RATE_LIMIT_PER_MINUTE`, default 120/min), request body cap (`MAX_BODY_MIB`, default 1 MiB) — over-limit → 413/429. Security headers + CSP on every response (`src/mcp/transport/http-entry.ts` `secureHeaders`). These apply to the new `/metrics` + `/ready` routes as well.

## 6. Incident quick paths

- **DB down**: `/ready` 503 with `reason` from the actual probe error. Replica leaves rotation; process stays up (liveness 200) — fix the DB, readiness recovers automatically.
- **Webhook storm / provider incident**: webhook route is HMAC-verified, event-id deduped; replays return `{status:"duplicate"}` 200. No action needed for replays; monitor `lkm_http_requests_total{route="/webhooks"}`.
- **Quota complaints from a tenant**: server-authoritative — check `GET /api/billing/summary` as that tenant's session; usage numbers come from the metering store, never the client.
- **Suspected billing bypass**: only verified webhooks mutate subscription state (transactional `applyEvent`); the checkout API never writes entitlements. Audit trail: `audit_log` rows `billing:checkout-initiated` / `billing:cancel-requested` / webhook event codes.

## 7. Verification evidence

- `tests/integration/ops-metrics-ready.test.ts` — 14 tests (registry semantics + real-server `/metrics` + `/ready` in both modes + broken-DB 503 path + GET-only 405).
- `scripts/workspace-stdio-smoke.mjs`, `scripts/workspace-http-smoke.mjs` — live-process workspace runs covering the full billing lifecycle + ops endpoints + self-hosted boundary (18/18 PASS).
