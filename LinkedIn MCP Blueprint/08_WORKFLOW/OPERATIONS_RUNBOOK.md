# Operational Runbook (M10 — Scale & Operations, issue #17)

**Status:** implemented and verified 2026-11-27. Restored 2026-11-28 after the baseline replacement removed the original file.

## 1. Probes

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/healthz` | GET | none | **Liveness** — process exists and answers. `{ok, backend, env}`. |
| `/ready` | GET | none | **Readiness** — replica can serve traffic. In-memory: always ready. Persistent: bounded 1s `SELECT 1` through the real pool; failing → **503** `{ok:false, reason}`. |
| `/metrics` | GET | none | **Prometheus text exposition** (`text/plain; version=0.0.4`). |

Load balancer wiring: liveness → `/healthz`, readiness → `/ready`, scrape 15–30s → `/metrics`. A replica failing readiness leaves rotation; it needs restart only if liveness fails too.

## 2. Metrics (in-process, zero dependencies)

| Metric | Type | Meaning |
|---|---|---|
| `lkm_http_requests_total{route}` | counter | Requests by fixed route class (`/mcp`, `/auth`, `/admin`, `/healthz`, `/ready`, `/metrics`, `/webhooks`, `/api/billing`, `/linkedin`, `other`). |
| `lkm_http_request_errors_total{route}` | counter | Responses with status ≥ 400. |
| `lkm_http_requests_inflight` | gauge | Requests currently served. |
| `lkm_mcp_tool_calls_total{tool,outcome}` | counter | Tool dispatch outcomes. Tool names are the **registered** names (parity test-enforced); unknown names collapse to `other`. |
| `lkm_billing_gate_total{outcome}` | counter | `allowed` / `no-entitlement` / `quota-exceeded`. |
| `lkm_process_uptime_seconds` | gauge | Uptime. |
| `lkm_process_restart_generation` | counter | 1 per boot. |

Cardinality is bounded in code; no tenant labels, no secrets, no payloads. Stdio mode never activates the registry.

## 3. Alert starting points

- `/ready != 200` for 2m → page DB health (response carries `reason`).
- `rate(lkm_http_request_errors_total{route="/mcp"}[5m]) > 0.1` sustained → inspect structured JSON logs.
- `lkm_http_requests_inflight` monotonic growth → connection leak; rotate the replica.
- Billing on + `lkm_billing_gate_total{outcome="no-entitlement"}` spike after a provider incident → check webhook delivery (Razorpay dashboard) + `/webhooks/razorpay` logs.
- New `restart_generation` on scrape → process restarted; correlate with deploy/crash.

## 4. Shutdown

SIGTERM/SIGINT → stop accepting → close DB pool → exit 0; hard-exit fallback at 10s. Deployments: send SIGTERM, wait ≤ 10s before SIGKILL.

## 5. Rate limits, body caps, headers

Per-IP token bucket (`HTTP_RATE_LIMIT_PER_MINUTE`, default 120), body cap (`MAX_BODY_MIB`, default 1) → 413/429. Security headers + CSP on every response. Apply to the probe routes too.

## 6. Incident quick paths

- **DB down** — `/ready` 503 with the probe `reason`; replica leaves rotation, process stays up; fix DB, readiness recovers automatically.
- **Webhook storm** — route is HMAC-verified + event-id deduped; replays answer `{status:"duplicate"}` 200. Monitor `route="/webhooks"` counters.
- **Quota complaint** — server-authoritative: check `/api/billing/summary` under the tenant's session; usage comes from the metering store.
- **Suspected billing bypass** — only verified webhooks mutate subscriptions (transactional `applyEvent`); checkout never writes entitlements. Audit trail: `billing:*` rows in `audit_log`.
- **Postgres `SET LOCAL` warnings / `pg_wal xlogtemp` PANIC in tests** — see `tests/integration/pg-*` and the workspace PG notes; root cause analysis recorded in the requirements matrix.

## 7. Verification evidence

- `tests/integration/ops-metrics-ready.test.ts` — 15 tests: registry semantics, metered-tools parity with the registered catalog, real-server `/metrics` + `/ready` in both modes, broken-DB 503 path, 405 handling.
- `scripts/workspace-stdio-smoke.mjs`, `scripts/workspace-http-smoke.mjs` — live-process workspace runs (billing lifecycle + ops surface + self-host boundary).
