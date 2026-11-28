/**
 * Master assignment steps 12/16 — the durable scheduler worker.
 *
 * Runs INDEPENDENTLY of any AI client session (the whole point: a
 * scheduled post must fire even after ChatGPT/Claude closed). Ties
 * together:
 *   - SqlScheduledPostStore.claimDue (exactly-one-worker claiming)
 *   - publishPostTool via a ToolContext (the FULL safety stack:
 *     duplicate ledger, daily budget, validation, authorization, audit)
 *   - billing entitlement gate (hosted mode): scheduling is a Tier C
 *     autonomous execution — it passes the same gate a manual publish
 *     does, at claim time AND at execution time.
 *
 * No duplicate execution: the claim transition is the idempotency
 * boundary; retries re-enter through claimDue, never by re-submitting.
 * A provider 'unknown outcome' failure (network cut after submission)
 * marks the row failed — the duplicate-content ledger protects a
 * re-submit at the tool layer anyway (ADR-016: no auto-retry).
 *
 * Restart survival: rows live in SQL; recoverInterrupted() at startup
 * recovers rows a crashed worker left in 'running'.
 */
import { createLogger } from '../observability/logger.js';
import type { AppRuntime } from '../mcp/serverFactory.js';
import { publishPostTool } from '../tools/publishTools.js';
import type { ToolContext } from '../tools/toolContext.js';
import type { ToolResult } from '../tools/connectionTools.js';
import { currentTenant, runWithTenant } from '../identity/requestTenant.js';
import { SqlScheduledPostStore } from './scheduledPostStore.js';

const log = createLogger('scheduling');

export interface PublishOutcome {
  readonly published: boolean;
  readonly postUrn?: string | undefined;
  readonly error?: string | undefined;
}

export interface SchedulerOptions {
  readonly pollMs: number;          // poll interval
  readonly maxAttempts: number;    // bounded retries
  readonly now: () => number;       // injectable clock
  /** Hard cap per scheduled execution; a wedged executor cannot wedge
   * the drain loop. Default 60s. */
  readonly executionTimeoutMs?: number;
  readonly executor: (post: { id: string; tenantId: string; postText: string }) => Promise<PublishOutcome>;
}

/**
 * Build the default executor: runs the REAL publishPostTool under the
 * post's tenant identity, through the runtime's ToolContext — wrapped in
 * the SAME billing gate and audit/metrics wrappers the MCP dispatch
 * uses (issue #22: the scheduler previously called publishPostTool
 * directly and BYPASSED entitlement + quota + audit entirely).
 *
 * Wrappers are injected by the caller (serverFactory) so this module
 * stays import-cycle-free; the fallback (plain run) only applies when
 * no gate is provided (pure in-memory local mode: no billing, and the
 * scheduler itself refuses to run without persistence anyway).
 */
export interface ExecutorWrappers {
  /** Entitlement+quota gate around the tool call (may refuse). */
  gate: (tool: string, fn: () => Promise<ToolResult>) => Promise<ToolResult>;
  /** Audit row + tool-call metric emission (never breaks the call). */
  audited: (tool: string, fn: () => Promise<ToolResult>) => Promise<ToolResult>;
}

export function toolExecutor(
  runtime: AppRuntime,
  wrappers?: ExecutorWrappers,
): SchedulerOptions['executor'] {
  const gate = wrappers?.gate ?? (async (_t, fn) => fn());
  const audited = wrappers?.audited ?? (async (_t, fn) => fn());
  return async (post) => {
    try {
      const ctx = toolContextFromRuntime(runtime);
      const result = await audited('linkedin_publish_post', () => gate('linkedin_publish_post', async () =>
        await publishPostTool(ctx, { text: post.postText, confirm: true })));
      // publishPostTool returns isError results for expected refusals
      // (not-connected, expired, duplicate, budget, entitlement). Those
      // are NOT retryable — the tool layer already decided.
      const text = result.content[0]?.text ?? '{}';
      let payload: { published?: boolean; postUrn?: string } = {};
      try { payload = JSON.parse(text) as { published?: boolean; postUrn?: string }; } catch { /* non-JSON error text */ }
      const outcome: PublishOutcome = result.isError === true
        ? { published: false, error: text.slice(0, 200) }
        : { published: payload.published === true, postUrn: payload.postUrn };
      return outcome;
    } catch (err) {
      // Thrown = unexpected infrastructure error: retryable (bounded).
      const outcome: PublishOutcome = { published: false, error: err instanceof Error ? err.message : String(err) };
      return outcome;
    }
  };
}

function toolContextFromRuntime(runtime: AppRuntime): ToolContext {
  // The ToolContext derives the tenant from the ALS request context.
  // The scheduler runs OUTSIDE a request: runWithTenant pins the post's
  // tenant for the duration of the execution so every gate (vault,
  // budget, billing) resolves the SAME tenant the post was created for.
  // The scheduler runs outside requests; runWithTenant (in executeOne)
  // pins the post's tenant for each execution, so currentTenant()
  // resolves the post's tenant at fire time. Production never injects
  // a factory — serverFactory constructs the scheduler directly.
  const tenant = currentTenant();
  return {
    config: runtime.config,
    tenant,
    connection: runtime.connection,
    callBudget: runtime.callBudgets.for(`linkedin-calls:${tenant.tenantId}`),
    vault: runtime.vault,
    provider: runtime.provider,
    postOps: runtime.postOps,
    publishBudget: runtime.publishBudgets.for(`publish:${tenant.tenantId}`),
    publishBudgetSql: runtime.publishBudgetSql,
    now: () => Date.now(),
    auditSink: runtime.authStore !== undefined
      ? async (tool, outcome) => { await runtime.authStore?.audit(tenant.tenantId, `tool:${tool}`, `tool-call:${outcome}`); }
      : undefined,
  };
}


/** Reject with a TimeoutError after ms, leaving the underlying promise
 * to its own devices (it is never awaited again by this path). */
function withTimeout<T>(p: Promise<T>, ms: number | undefined, label: string): Promise<T> {
  if (ms === undefined) return p;
  const timeoutErr = new Error(label);
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { reject(timeoutErr); }, ms);
    t.unref();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

export class PostScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly store: SqlScheduledPostStore;

  constructor(
    private readonly storeExec: { exec: import('../storage/sqlExecutor.js').SqlExecutor },
    private readonly opts: SchedulerOptions,
  ) {
    this.store = new SqlScheduledPostStore(storeExec.exec, { maxAttempts: opts.maxAttempts });
  }

  /** Start the worker loop (idempotent). */
  start(): void {
    if (this.timer !== undefined) return;
    const tick = (): void => {
      // Issue #25: a tick error (DB hiccup, pool exhaustion) must NEVER
      // surface as an unhandled rejection — Node >=15 default-terminates
      // the process on those. Log and let the next tick retry.
      void this.drain().catch((err: unknown) => {
        log.error('scheduler tick failed (recoverable)', { error: err instanceof Error ? err.message : String(err) });
      });
    };
    this.timer = setInterval(tick, this.opts.pollMs);
    this.timer.unref(); // never keep the process alive on its own
    log.info('scheduler started', { pollMs: this.opts.pollMs });
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Startup recovery: re-schedule rows a crash left 'running'. */
  async recover(): Promise<number> {
    const n = await this.store.recoverInterrupted();
    if (n > 0) log.info('scheduler recovered interrupted posts', { count: n });
    return n;
  }

/** One poll pass: claim due posts until none remain, execute each. */
  async drain(): Promise<number> {
    if (this.running) return 0; // re-entrancy guard: one drain at a time
    this.running = true;
    let executed = 0;
    try {
      for (let i = 0; i < 100; i++) { // hard bound per tick
        const claim = await this.store.claimDue(this.opts.now());
        if (!claim.claimed || claim.post === undefined) break;
        executed += 1;
        await this.executeOne(claim.post.id, claim.post.tenantId, claim.post.postText);
      }
    } finally {
      this.running = false;
    }
    return executed;
  }

  private async executeOne(id: string, tenantId: string, postText: string): Promise<void> {
    let outcome: PublishOutcome;
    let retryable = false;
    try {
      const execution = runWithTenant({ tenantId, userId: tenantId }, async () => this.opts.executor({ id, tenantId, postText }));
      // Issue #29 (watchdog): a wedged executor (hung provider call,
      // stuck socket) must not wedge the drain loop forever — bound each
      // execution with a hard timeout. On timeout the row is retried
      // (bounded) like any other infrastructure error.
      outcome = await withTimeout(execution, this.opts.executionTimeoutMs, 'scheduled execution timed out');
    } catch (err) {
      // Thrown = unexpected infrastructure error: retryable (bounded).
      retryable = true;
      outcome = { published: false, error: err instanceof Error ? err.message : String(err) } satisfies PublishOutcome;
    }
    if (outcome.published) {
      // Issue #24: the store guard now reports whether the row was still
      // 'running' — a lost guard means the user cancelled mid-execution
      // and the provider content already went out; the ROW must stay
      // 'cancelled' (no silent overwrite) and we log the collision.
      // Issue #25: store errors after a successful publish degrade to a
      // log line, never an unhandled rejection; the post DID go out.
      const won = await this.store.markPublished(id, outcome.postUrn ?? 'unknown-urn').catch(() => null);
      if (won === null) {
        log.error('markPublished failed (post was published; row state stale)', { id, tenant: tenantId });
        return;
      }
      if (won) {
        log.info('scheduled post published', { id, tenant: tenantId });
      } else {
        log.warn('scheduled post published but row was cancelled mid-execution; keeping cancelled state', { id, tenant: tenantId });
      }
      return;
    }
    try {
      await this.store.markFailed(id, outcome.error ?? 'publish refused', retryable, this.opts.now());
    } catch (err) {
      // Issue #25: failure-marking failures are logged; the row stays
      // 'running' and recoverInterrupted() will handle it at next boot.
      log.error('markFailed failed (row left for restart recovery)', {
        id, tenant: tenantId, error: err instanceof Error ? err.message : String(err),
      });
    }
    log.warn('scheduled post not published', { id, tenant: tenantId, retryable, error: outcome.error?.slice(0, 120) });
  }
}

