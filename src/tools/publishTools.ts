/**
 * M4 tools: LinkedIn post draft / preview / publish.
 *
 * Authorization model (owner directives D-A1 + M4 Phase 3/4):
 * - draft/preview are pure local operations: validation + preview only,
 *   never a provider call, no connection required (identical content rules
 *   for connected and disconnected callers);
 * - publish requires an ACTIVE connection with w_member_social, the
 *   explicit schema-forced confirm:true gate (publishing is disabled
 *   unless the user confirms), and passes through the same authorize()
 *   boundary as every LinkedIn-touching tool;
 * - the author identity is the tenant's sealed token + its member sub —
 *   caller-supplied author URNs are not part of any schema, so identity
 *   substitution is impossible by construction;
 * - write safety: content-hash duplicate window, in-flight lock, NO
 *   automatic retry for uncertain outcomes (ambiguous results are
 *   surfaced, never re-sent; ADR-016);
 * - rate safety: per-tenant daily publish budget (application safety
 *   limit; LinkedIn publishes no numeric quota — ADR-015).
 */
import * as z from 'zod/v4';
import { createLogger } from '../observability/logger.js';
import { authorize, type ToolPolicy } from '../policy/toolPolicy.js';
import type { ToolContext } from './toolContext.js';
import type { ToolResult } from './connectionTools.js';
import { ProviderError } from '../auth/linkedin/provider.js';
import {
  fingerprintPostText,
  DuplicateOperationError,
  PostOperationStore,
} from '../auth/linkedin/postOperationStore.js';
import {
  reportPostText,
  validatePostText,
  POST_TEXT_MAX_LENGTH,
} from './postValidation.js';
import { fingerprintPostUrn } from '../auth/linkedin/publishResult.js';
import type { SqlPostOperationStore } from '../auth/linkedin/sqlPublishStores.js';
import { SqlPostOperationStore as SqlOpsClass } from '../auth/linkedin/sqlPublishStores.js';

const log = createLogger('tools:publish');

export const DraftPostInputSchema = z
  .object({
    text: z.string().max(POST_TEXT_MAX_LENGTH * 2, 'post text far exceeds any limit'),
  })
  .strict();

export const PreviewPostInputSchema = z
  .object({
    text: z.string().max(POST_TEXT_MAX_LENGTH * 2, 'post text far exceeds any limit'),
  })
  .strict();

export const PublishPostInputSchema = z
  .object({
    text: z.string().max(POST_TEXT_MAX_LENGTH * 2, 'post text far exceeds any limit'),
    /** Publishing is disabled unless explicitly confirmed (literal true). */
    confirm: z.literal(true),
  })
  .strict();

/** Publish policy: w_member_social, write, confirmation-required. */
export const PUBLISH_POLICY: ToolPolicy = {
  requiredScopes: ['w_member_social'],
  effects: 'write',
  confirmation: 'confirmation-required',
  audit: true,
};

/** Draft/preview policy: local-only, no provider interaction. */
export const DRAFT_POLICY: ToolPolicy = {
  requiredScopes: [],
  effects: 'read',
  confirmation: 'none',
  audit: false,
};

export const DRAFT_TOOL_SPEC = {
  name: 'linkedin_draft_post',
  title: 'Draft a LinkedIn post (validation + preview)',
  description:
    'Validates post text against the official LinkedIn limits (3000 characters, non-blank) and returns a structured draft with a preview. Local only: nothing is sent to LinkedIn, no account is required, and the draft is NOT saved persistently — it is returned for the caller to hold. Text-only posts; media is not supported in this milestone.',
  inputSchema: DraftPostInputSchema,
  policy: DRAFT_POLICY,
} as const;

export const PREVIEW_TOOL_SPEC = {
  name: 'linkedin_preview_post',
  title: 'Preview a post exactly as it would be submitted',
  description:
    'Returns the exact JSON payload a publish would submit (author, commentary, visibility, distribution, lifecycleState), with the author filled from the connected account when one exists. Reports validation results and limitations. No side effects and no LinkedIn call.',
  inputSchema: PreviewPostInputSchema,
  policy: DRAFT_POLICY,
} as const;

export const PUBLISH_TOOL_SPEC = {
  name: 'linkedin_publish_post',
  title: 'Publish a post to the connected LinkedIn account',
  description:
    'Publishes a text-only post via the official LinkedIn Posts API on behalf of the connected account. Requires confirm=true (publishing is refused otherwise). Requires an active connection with the w_member_social scope. The author is always the connected account; identity cannot be supplied. Identical content is refused within a duplicate window; uncertain outcomes (timeout) are reported as ambiguous and are never auto-retried.',
  inputSchema: PublishPostInputSchema,
  policy: PUBLISH_POLICY,
} as const;

function errorResult(message: string, code?: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}

/** Resolve the connected member sub for the tenant, or null when absent. */
async function connectedMember(
  ctx: ToolContext,
): Promise<{ sub: string | null; scopes: readonly string[] }> {
  const tokens = await ctx.vault.get(ctx.tenant);
  if (tokens === undefined) {
    return { sub: null, scopes: [] };
  }
  return { sub: tokens.memberSub ?? null, scopes: tokens.scopes };
}

/** The exact request payload the provider sends for a text post. */
function postPayload(author: string, text: string): Record<string, unknown> {
  return {
    author,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
}

export function draftPostTool(
  _ctx: ToolContext,
  input: z.infer<typeof DraftPostInputSchema>,
): ToolResult {
  const report = reportPostText(input.text);
  const payload: Record<string, unknown> = {
    draft: {
      text: input.text,
      validation: report,
      valid: report.valid,
    },
    preview: input.text,
    persistence: 'none — this draft is returned, not stored',
    note: 'Text-only posts; media, mentions and targeting are not supported in this milestone.',
  };
  if (!report.valid) {
    payload.valid = false;
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export async function previewPostTool(
  ctx: ToolContext,
  input: z.infer<typeof PreviewPostInputSchema>,
): Promise<ToolResult> {
  const report = reportPostText(input.text);
  const { sub } = await connectedMember(ctx);
  // Author: the connected identity when present; a placeholder marker when
  // not (preview is local and must not fake a connected identity).
  const author = sub !== null ? `urn:li:person:${sub}` : '(not connected — author resolves at publish)';
  const payload: Record<string, unknown> = {
    exactSubmission: postPayload(author, input.text),

    authorIdentity: sub !== null ? 'connected account' : 'no connection',
    limitations: [
      'Text-only; media, mentions, targeting and reshares are not supported in this milestone.',
      'Preview is local: LinkedIn may still reject the post at publish time.',
      report.valid ? null : 'Content currently fails validation and would not be submitted.',
    ].filter((x): x is string => x !== null),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export async function publishPostTool(
  ctx: ToolContext,
  input: z.infer<typeof PublishPostInputSchema>,
): Promise<ToolResult> {
  // 0. The confirmation gate is structural: the schema is z.literal(true).
  //    confirm:false / missing confirm never reach this function — the MCP
  //    layer rejects the call with a schema error before any side effect.
  // 1. Connection state first (expiry distinct from never-connected).
  const tokens = await ctx.vault.get(ctx.tenant);
  const now = ctx.now();
  if (tokens === undefined) {
    return errorResult('No LinkedIn account is connected.', 'not-connected');
  }
  if (tokens.expiresAt <= now) {
    return errorResult('LinkedIn connection expired; reconnect to continue.', 'expired');
  }
  // 2. Authorization at the tool boundary.
  const decision = authorize({
    toolName: 'linkedin_publish_post',
    policy: PUBLISH_POLICY,
    tenant: ctx.tenant,
    connection: { connected: true, scopes: tokens.scopes },
  });
  if (!decision.allow) {
    return errorResult(decision.message, decision.code);
  }
  // 3. Resolve the authenticated author identity (OIDC sub).
  const sub = tokens.memberSub ?? null;
  if (sub === null || sub === 'pending') {
    // Connected but the member id is not yet resolved: publishing needs a
    // definite author; we refuse rather than publish with a pending author.
    return errorResult(
      'Connected account identity is not resolved yet; run get_my_profile first, then retry.',
      'identity-unresolved',
    );
  }
  // 4. Validate content before submission.
  try {
    validatePostText(input.text);
  } catch (err) {
    if (err instanceof Error && err.name === 'PostValidationError') {
      return errorResult(err.message, `invalid-content-${(err as { code?: string }).code ?? 'unknown'}`);
    }
    throw err;
  }
  // 5/6. Duplicate-content protection + daily budget (ledger local or SQL,
  // ADR-015/016/018). The memory branch consumes the budget; the SQL branch
  // uses the transactional SqlPublishBudget.
  const hash = fingerprintPostText(input.text);
  if (ctx.publishBudgetSql !== undefined || isSqlOps(ctx.postOps)) {
    // SQL ledger: enter(tenantId, text) computes the hash internally and
    // prunes expired rows first.
    try {
      if (isSqlOps(ctx.postOps)) {
        await ctx.postOps.enter(ctx.tenant.tenantId, input.text);
      }
    } catch (err) {
      if (err instanceof DuplicateOperationError) {
        return errorResult(err.message, `duplicate-${err.reason}`);
      }
      throw err;
    }
    // SQL budget: single transaction-checked take.
    const sqlBudget = ctx.publishBudgetSql;
    if (sqlBudget !== undefined && !(await sqlBudget.take(ctx.tenant.tenantId))) {
      return errorResult(
        'Daily publication budget exhausted for this account; try again tomorrow.',
        'rate-limited',
      );
    }
  } else {
    const memOps: PostOperationStore = ctx.postOps;
    try {
      memOps.enter(ctx.tenant.tenantId, hash);
    } catch (err) {
      if (err instanceof DuplicateOperationError) {
        return errorResult(err.message, `duplicate-${err.reason}`);
      }
      throw err;
    }
    if (!ctx.publishBudget.take()) {
      return errorResult(
        'Daily publication budget exhausted for this account; try again tomorrow.',
        'rate-limited',
      );
    }
  }
  // 7. Submit — no automatic retry (ADR-016).
  try {
    const result = await ctx.provider.publishPost({
      accessToken: tokens.accessToken,
      memberSub: sub,
      text: input.text,
    });
    if (isSqlOps(ctx.postOps)) {
      await ctx.postOps.exit(ctx.tenant.tenantId, hash, 'success', result.postUrn);
    } else {
      const memOps: PostOperationStore = ctx.postOps;
      memOps.exit(ctx.tenant.tenantId, hash, 'success', result.postUrn);
    }
    const payload = {
      published: true,
      confirmedByProvider: true,
      postUrn: result.postUrn,
      postUrnFingerprint: fingerprintPostUrn(result.postUrn ?? ''),
      note: 'LinkedIn confirmed creation (201 + x-restli-id).',
    };
    log.info('post published', {
      tenant: ctx.tenant.tenantId,
      urnFingerprint: payload.postUrnFingerprint,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload as unknown as Record<string, unknown>,
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      // Classify the outcome for the operation ledger BEFORE returning:
      // 4xx = definite refusal (safe to retry by the user later);
      // timeout/network/5xx = ambiguous (may have been accepted).
      const ambiguous = err.code === 'timeout' || err.code === 'network' || (err.code === 'http-status' && (err.status ?? 0) >= 500);
      if (isSqlOps(ctx.postOps)) {
        await ctx.postOps.exit(ctx.tenant.tenantId, hash, ambiguous ? 'ambiguous' : 'failure');
      } else {
        const memOps: PostOperationStore = ctx.postOps;
        memOps.exit(ctx.tenant.tenantId, hash, ambiguous ? 'ambiguous' : 'failure');
      }
      const message =
        err.code === 'timeout'
          ? 'LinkedIn did not respond in time; the post may or may not have been created. Verify on LinkedIn before retrying this exact content.'
          : err.code === 'network'
            ? 'The publish request failed mid-flight; the post may or may not have been created. Verify on LinkedIn before retrying this exact content.'
            : err.code === 'write-rejected'
              ? 'LinkedIn refused the post (content, permission or limit).'
              : err.code === 'http-status' && err.status === 401
                ? 'LinkedIn rejected the access token (expired or revoked); reconnect.'
                : 'Publishing failed.';
      const code =
        ambiguous ? 'ambiguous' : `provider-${err.code}`;
      log.warn('publish provider error', { code: err.code, status: err.status ?? undefined, ambiguous });
      return errorResult(message, code);
    }
    // Non-provider failure: the request never left reliably — treat as
    // ambiguous (ledger conservative) and surface a safe error.
    if (isSqlOps(ctx.postOps)) {
      await ctx.postOps.exit(ctx.tenant.tenantId, hash, 'ambiguous');
    } else {
      const memOps: PostOperationStore = ctx.postOps;
      memOps.exit(ctx.tenant.tenantId, hash, 'ambiguous');
    }
    log.error('unexpected publish error', { error: err instanceof Error ? err.message : String(err) });
    return errorResult('Unexpected error during publishing; outcome unknown.', 'ambiguous');
  }
}

/** Narrow the runtime's op-ledger union to the SQL variant. */
function isSqlOps(
  ops: PostOperationStore | SqlPostOperationStore,
): ops is SqlPostOperationStore {
  return ops instanceof SqlOpsClass;
}
