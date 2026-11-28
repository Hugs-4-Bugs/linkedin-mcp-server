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
  readonly executor: (post: { id: string; tenantId: string; postText: string }) => Promise<PublishOutcome>;
}

/**
 * Build the default executor: runs the REAL publishPostTool under the
 * post's tenant identity, through the runtime's ToolContext — so the
 * scheduled publish passes the same authorization, budget, duplicate
 * and billing gates as a manual one.
 */
export function toolExecutor(runtime: AppRuntime): SchedulerOptions['executor'] {
  return async (post) => {
    try {
      const ctx = toolContextFromRuntime(runtime);
      const result = await publishPostTool(ctx, { text: post.postText, confirm: true });
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
  // The factory is injected by wireScheduler (which owns the real
  // toolContext module reference); the fallback mirrors its shape.
  if (toolContextFn !== undefined) {
    return toolContextFn(runtime);
  }
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

// Injected by wireScheduler to avoid a circular import (serverFactory
// imports scheduler wiring; the scheduler needs the toolContext factory
// that lives in serverFactory). Lazily resolved, never at module load.
let toolContextFn: ((runtime: AppRuntime) => ToolContext) | undefined;

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
      void this.drain();
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
      outcome = await runWithTenant({ tenantId, userId: tenantId }, async () => this.opts.executor({ id, tenantId, postText }));
    } catch (err) {
      // Thrown = unexpected infrastructure error: retryable (bounded).
      retryable = true;
      outcome = { published: false, error: err instanceof Error ? err.message : String(err) } satisfies PublishOutcome;
    }
    if (outcome.published) {
      await this.store.markPublished(id, outcome.postUrn ?? 'unknown-urn');
      log.info('scheduled post published', { id, tenant: tenantId });
      return;
    }
    await this.store.markFailed(id, outcome.error ?? 'publish refused', retryable);
    log.warn('scheduled post not published', { id, tenant: tenantId, retryable, error: outcome.error?.slice(0, 120) });
  }
}

/** Wire the scheduler into a runtime's lifecycle (persistent mode only). */
export function wireScheduler(
  runtime: AppRuntime,
  deps: {
    exec: import('../storage/sqlExecutor.js').SqlExecutor;
    toolContextFactory: (runtime: AppRuntime) => ToolContext;
    pollMs?: number;
    maxAttempts?: number;
    now?: () => number;
  },
): PostScheduler {
  toolContextFn = deps.toolContextFactory;
  const scheduler = new PostScheduler({ exec: deps.exec }, {
    pollMs: deps.pollMs ?? 5_000,
    maxAttempts: deps.maxAttempts ?? 3,
    now: deps.now ?? (() => Date.now()),
    executor: toolExecutor(runtime),
  });
  void scheduler.recover().then(() => { scheduler.start(); });
  return scheduler;
}
