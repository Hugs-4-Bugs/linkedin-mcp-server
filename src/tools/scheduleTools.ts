/**
 * Master assignment step 12 — scheduling MCP tools.
 *
 * User-facing surface over SqlScheduledPostStore + PostScheduler:
 *   - linkedin_schedule_post   (Tier C autonomous execution: durable,
 *     survives restarts, client session NOT required at fire time)
 *   - linkedin_list_scheduled_posts
 *   - linkedin_cancel_scheduled_post (Tier C revocation)
 *
 * Safety properties (tests enforce):
 *   - schedule requires confirm:true (structural literal gate — same
 *     pattern as publish/disconnect).
 *   - Content is validated by the SAME validator as publish (a
 *     scheduled post that would fail validation is refused at schedule
 *     time — never stored to fail later).
 *   - runAt must be in the future (a past date is refused: the worker
 *     would immediately claim it, which is what 'publish now' is for).
 *   - Scheduling requires persistence (DATABASE_URL): in-memory local
 *     mode has no durable queue; the tool refuses rather than silently
 *     dropping the work (a schedule that dies with the process would be
 *     a fake feature).
 *   - The scheduled execution passes the FULL publish safety stack at
 *     fire time (duplicate ledger, budget, entitlement) — nothing is
 *     pre-approved at schedule time.
 */
import { z } from 'zod';
import { type ToolPolicy, WRITE_CONFIRMED, READ_ONLY } from '../policy/toolPolicy.js';
import { validatePostText } from './postValidation.js';
import type { ToolContext } from './toolContext.js';
import type { ToolResult } from './connectionTools.js';
import type { SqlScheduledPostStore } from '../scheduling/scheduledPostStore.js';

function okResult(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function errorResult(message: string, code?: string): ToolResult {
  const payload: Record<string, unknown> = { error: message };
  if (code !== undefined) payload.code = code;
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

export const SchedulePostInputSchema = z.object({
  text: z.string().min(1).max(3000),
  /** Minutes from now the post should be published (durable queue delay). */
  runInMinutes: z.number().int().min(1).max(60 * 24 * 30),
  confirm: z.literal(true),
});

export const ListScheduledPostsInputSchema = z.object({});

export const CancelScheduledPostInputSchema = z.object({
  id: z.string().min(1),
  confirm: z.literal(true),
});

// Tier C (autonomous execution): requires explicit confirmation and a
// durable queue; see the autonomy policy module for the tier model.
export const SCHEDULE_POLICY: ToolPolicy = WRITE_CONFIRMED;

export const SCHEDULE_TOOL_SPEC = {
  name: 'linkedin_schedule_post',
  title: 'Schedule a post for durable future publication',
  description:
    'Queues a text post for publication at a future time (minutes from now). The schedule is DURABLE: it survives server restarts and does not require the AI client to remain connected. At fire time the post passes the same safety gates as an immediate publish (connection, scope, duplicate window, daily budget, entitlement). Requires confirm=true. Requires persistent storage (DATABASE_URL) — in-memory local mode refuses instead of silently losing the schedule. Max delay 30 days.',
  inputSchema: SchedulePostInputSchema,
  policy: SCHEDULE_POLICY,
} as const;

export const LIST_SCHEDULED_TOOL_SPEC = {
  name: 'linkedin_list_scheduled_posts',
  title: 'List scheduled posts for this account',
  description:
    'Lists scheduled, running, published, failed and cancelled posts for the current tenant with their status, attempts and last error. Read-only.',
  inputSchema: ListScheduledPostsInputSchema,
  policy: READ_ONLY,
} as const;

export const CANCEL_SCHEDULED_TOOL_SPEC = {
  name: 'linkedin_cancel_scheduled_post',
  title: 'Cancel a scheduled post',
  description:
    'Cancels a not-yet-executed scheduled post. Requires confirm=true. Cancellation of an already-published post is refused (use LinkedIn itself for deletions — this tool never deletes provider content).',
  inputSchema: CancelScheduledPostInputSchema,
  policy: SCHEDULE_POLICY,
} as const;

export async function schedulePostTool(
  ctx: ToolContext,
  input: z.infer<typeof SchedulePostInputSchema>,
  store: SqlScheduledPostStore | undefined,
  now: () => number,
): Promise<ToolResult> {
  if (store === undefined) {
    return errorResult(
      'Scheduling requires persistent storage (DATABASE_URL). Local in-memory mode has no durable queue; an undelivered schedule would be silently lost — refused rather than faked.',
      'persistence-required',
    );
  }
  try {
    validatePostText(input.text);
  } catch (err) {
    if (err instanceof Error && err.name === 'PostValidationError') {
      return errorResult(err.message, `invalid-content-${(err as { code?: string }).code ?? 'unknown'}`);
    }
    throw err;
  }
  const runAtMs = now() + input.runInMinutes * 60_000;
  const row = await store.insert({
    tenantId: ctx.tenant.tenantId,
    postText: input.text,
    runAtMs,
  });
  return okResult({
    scheduled: true,
    id: row.id,
    runAtIso: row.runAt,
    runInMinutes: input.runInMinutes,
    durable: true,
    note: 'Survives restarts; fires without the AI client; passes full publish safety gates at fire time.',
  });
}

export async function listScheduledPostsTool(
  ctx: ToolContext,
  store: SqlScheduledPostStore | undefined,
): Promise<ToolResult> {
  if (store === undefined) {
    return errorResult(
      'Scheduling requires persistent storage (DATABASE_URL); nothing is scheduled in this mode.',
      'persistence-required',
    );
  }
  const rows = await store.list(ctx.tenant.tenantId);
  return okResult({
    count: rows.length,
    posts: rows.map((r) => ({
      id: r.id,
      runAt: r.runAt,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      postUrn: r.postUrn,
    })),
  });
}

export async function cancelScheduledPostTool(
  ctx: ToolContext,
  input: z.infer<typeof CancelScheduledPostInputSchema>,
  store: SqlScheduledPostStore | undefined,
): Promise<ToolResult> {
  if (store === undefined) {
    return errorResult(
      'Scheduling requires persistent storage (DATABASE_URL).',
      'persistence-required',
    );
  }
  const cancelled = await store.cancel(input.id, ctx.tenant.tenantId);
  if (!cancelled) {
    return errorResult(
      'Not found, already published, already cancelled — or another tenant\u2019s post.',
      'not-cancellable',
    );
  }
  return okResult({ cancelled: true, id: input.id });
}
