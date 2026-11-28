/**
 * M10 issue #17 — in-process operational metrics (Observability).
 *
 * Design constraints (ADR discipline of this repo: modular monolith,
 * Phase 1 only — no external collector dependency):
 *   - Zero new npm dependencies: counters + gauges in plain TS, exported
 *     in Prometheus text exposition format on /metrics.
 *   - Cardinality is BOUNDED by design: no tenant/tool label dimensions
 *     beyond a fixed small set (tool name + route class + outcome). This
 *     is a low-traffic MVP; unbounded label space is the classic metrics
 *     leak — a hostile client must not be able to grow memory by driving
 *     unique labels.
 *   - Counters are monotonic Longs; gauges are point-in-time snapshots.
 *   - Registration is explicit: only the fixed label set is accepted
 *     (label whitelisting enforced in code, not by convention).
 *
 * Exposed families (all optional except the four core ones):
 *   lkm_http_requests_total{route,outcome}   — /mcp, /auth, /webhooks, …
 *   lkm_http_request_errors_total{route}    — 4xx/5xx subset counter
 *   lkm_http_requests_inflight              — gauge, server in-flight
 *   lkm_mcp_tool_calls_total{tool,outcome}  — audited dispatch outcomes
 *   lkm_billing_gate_total{outcome}         — entitlement/quota refusals
 *   lkm_process_uptime_seconds              — process uptime gauge
 *   lkm_process_restart_generation          — boot counter (per-process 1)
 *
 * The module is deliberately dependency-free so stdio mode pays nothing:
 * metrics only activate in the HTTP entry (server factory wires the sink).
 */
export type MetricOutcome = 'ok' | 'error';
export type RouteClass = '/mcp' | '/auth' | '/admin' | '/healthz' | '/ready' | '/metrics' | '/webhooks' | '/api/billing' | '/linkedin' | 'other';

/**
 * Fixed tool-name allowlist: the registered catalog (bounded labels).
 * Audit defect fix (2026-11-28): four names previously omitted the
 * linkedin_ prefix used by the REGISTERED tool names, so those tools
 * silently collapsed into the 'other' bucket. Names must now match the
 * registered catalog exactly; the ops tests enforce the parity.
 */
export const METERED_TOOLS: readonly string[] = [
  'linkedin_connect',
  'linkedin_status',
  'linkedin_disconnect',
  'linkedin_get_my_profile',
  'linkedin_list_granted_scopes',
  'linkedin_draft_post',
  'linkedin_preview_post',
  'linkedin_publish_post',
  'status',
] as const;

export interface MetricsSnapshot {
  httpRequests: number;
  httpErrors: number;
  inFlight: number;
  toolCalls: Map<string, { ok: number; error: number }>;
  billingGate: Map<string, number>;
  startedAt: number;
  restartGeneration: number;
}

export class MetricsRegistry {
  private readonly httpRequests = new Map<string, number>();
  private readonly httpErrors = new Map<string, number>();
  private readonly toolCalls = new Map<string, { ok: number; error: number }>();
  private readonly billingGate = new Map<string, number>();
  private inFlight = 0;
  private readonly startedAt = Date.now();
  private readonly restartGeneration = 1;

  /** Bounded cardinality guard: only the fixed route classes are counted. */
  private static readonly ROUTES: readonly RouteClass[] = [
    '/mcp', '/auth', '/admin', '/healthz', '/ready', '/metrics', '/webhooks', '/api/billing', '/linkedin', 'other',
  ];

  /** Classify a request path into the fixed route-class set. */
  static routeClassOf(path: string): RouteClass {
    if (path === '/mcp' || path === '/mcp/') return '/mcp';
    if (path.startsWith('/auth/')) return '/auth';
    if (path === '/admin' || path === '/admin/') return '/admin';
    if (path === '/healthz') return '/healthz';
    if (path === '/ready') return '/ready';
    if (path === '/metrics') return '/metrics';
    if (path.startsWith('/webhooks/')) return '/webhooks';
    if (path.startsWith('/api/billing/')) return '/api/billing';
    if (path.startsWith('/linkedin/')) return '/linkedin';
    return 'other';
  }

  httpStart(): void {
    this.inFlight += 1;
  }

  httpEnd(route: RouteClass, status: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.httpRequests.set(route, (this.httpRequests.get(route) ?? 0) + 1);
    if (status >= 400) {
      this.httpErrors.set(route, (this.httpErrors.get(route) ?? 0) + 1);
    }
  }

  /** In-flight drift repair hook (called from 'close' events). */
  httpAborted(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  toolCall(tool: string, outcome: MetricOutcome): void {
    // Unknown tool names collapse into 'other' — bounded label space.
    const name = MetricsRegistry.isMetered(tool) ? tool : 'other';
    const cur = this.toolCalls.get(name) ?? { ok: 0, error: 0 };
    cur[outcome] += 1;
    this.toolCalls.set(name, cur);
  }

  billingGateDecision(outcome: 'allowed' | 'no-entitlement' | 'quota-exceeded'): void {
    this.billingGate.set(outcome, (this.billingGate.get(outcome) ?? 0) + 1);
  }

  static isMetered(tool: string): boolean {
    return METERED_TOOLS.includes(tool);
  }

  snapshot(): MetricsSnapshot {
    return {
      httpRequests: [...this.httpRequests.entries()].reduce((a, [, v]) => a + v, 0),
      httpErrors: [...this.httpErrors.values()].reduce((a, v) => a + v, 0),
      inFlight: this.inFlight,
      toolCalls: new Map(this.toolCalls),
      billingGate: new Map(this.billingGate),
      startedAt: this.startedAt,
      restartGeneration: this.restartGeneration,
    };
  }

  /**
   * Prometheus text exposition (format v0.0.4, text/plain). Only this
   * process's own numbers — no host/process introspection beyond uptime.
   */
  render(): string {
    const lines: string[] = [];
    const totalReqs = [...this.httpRequests.entries()].reduce((a, [, v]) => a + v, 0);
    const totalErrs = [...this.httpErrors.values()].reduce((a, v) => a + v, 0);
    lines.push('# HELP lkm_http_requests_total Total HTTP requests by route class.');
    lines.push('# TYPE lkm_http_requests_total counter');
    for (const [r, v] of this.httpRequests) lines.push(`lkm_http_requests_total{route="${r}"} ${String(v)}`);
    if (totalReqs === 0) lines.push('lkm_http_requests_total 0');
    lines.push('# HELP lkm_http_request_errors_total HTTP error responses (status >= 400) by route class.');
    lines.push('# TYPE lkm_http_request_errors_total counter');
    for (const [r, v] of this.httpErrors) lines.push(`lkm_http_request_errors_total{route="${r}"} ${String(v)}`);
    if (totalErrs === 0) lines.push('lkm_http_request_errors_total 0');
    lines.push('# HELP lkm_http_requests_inflight Requests currently being served.');
    lines.push('# TYPE lkm_http_requests_inflight gauge');
    lines.push(`lkm_http_requests_inflight ${String(this.inFlight)}`);
    lines.push('# HELP lkm_mcp_tool_calls_total MCP tool calls by tool and outcome.');
    lines.push('# TYPE lkm_mcp_tool_calls_total counter');
    for (const [t, c] of this.toolCalls) {
      lines.push(`lkm_mcp_tool_calls_total{tool="${t}",outcome="ok"} ${String(c.ok)}`);
      lines.push(`lkm_mcp_tool_calls_total{tool="${t}",outcome="error"} ${String(c.error)}`);
    }
    lines.push('# HELP lkm_billing_gate_total Billing gate decisions by outcome.');
    lines.push('# TYPE lkm_billing_gate_total counter');
    for (const [o, v] of this.billingGate) lines.push(`lkm_billing_gate_total{outcome="${o}"} ${String(v)}`);
    lines.push('# HELP lkm_process_uptime_seconds Process uptime in seconds.');
    lines.push('# TYPE lkm_process_uptime_seconds gauge');
    lines.push(`lkm_process_uptime_seconds ${String(Math.floor((Date.now() - this.startedAt) / 1000))}`);
    lines.push('# HELP lkm_process_restart_generation Boot generation (1 per process start).');
    lines.push('# TYPE lkm_process_restart_generation counter');
    lines.push('lkm_process_restart_generation 1');
    return `${lines.join('\n')}\n`;
  }
}

/** Global registry wired by the HTTP entry (stdio mode never touches it). */
export const metrics = new MetricsRegistry();
