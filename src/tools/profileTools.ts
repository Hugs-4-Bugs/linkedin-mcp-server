/**
 * M3 tool: get_my_profile — the authenticated member's OIDC userinfo.
 *
 * Authorization model (owner requirement §4):
 * - identity comes from the tenant's sealed token, NEVER from arguments
 *   (the schema takes no member id at all, so substitution is impossible
 *   by construction);
 * - the tool requires an ACTIVE connection: authorize() runs against live
 *   vault state (connected + unexpired) with the profile scope set;
 * - profile data is fetched with the tenant's own token → tenant-isolated;
 * - all provider failures map to safe, structured errors (no bodies).
 */
import * as z from 'zod/v4';
import { createLogger } from '../observability/logger.js';
import { authorize, READ_ONLY, type ToolPolicy } from '../policy/toolPolicy.js';
import type { ToolContext } from './toolContext.js';
import type { ToolResult } from './connectionTools.js';
import { ProviderError } from '../auth/linkedin/provider.js';
import { buildScopeReport } from '../auth/linkedin/scopeReport.js';
import { validateUserInfo, UserinfoValidationError } from '../auth/linkedin/userinfoSchema.js';

const log = createLogger('tools:profile');

export const GetMyProfileInputSchema = z.object({}).strict();

/** Profile policy: openid+profile scopes, read effect, no confirmation. */
export const PROFILE_POLICY: ToolPolicy = {
  requiredScopes: ['openid', 'profile'],
  effects: 'read',
  confirmation: 'none',
  audit: true,
};

/** Profile view served to the caller: only permitted, present fields. */
export interface ProfileView {
  memberId: string;
  name?: string | undefined;
  givenName?: string | undefined;
  familyName?: string | undefined;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  locale?: { language: string; country?: string | undefined } | undefined;
  profilePictureUrl?: string | undefined;
}

export const PROFILE_TOOL_SPEC = {
  name: 'linkedin_get_my_profile',
  title: 'Get my LinkedIn profile',
  description:
    'Returns the authenticated member\'s LinkedIn profile (OIDC userinfo: name, email, locale, picture) using the connected account\'s access token. No arguments: the identity is the connected account, not caller-supplied. Requires an active connection.',
  inputSchema: GetMyProfileInputSchema,
  policy: PROFILE_POLICY,
} as const;

function errorResult(message: string, code?: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}

export async function getMyProfileTool(ctx: ToolContext): Promise<ToolResult> {
  // 1. Classify connection state FIRST so expiry is distinguishable from
  //    never-connected (the scope-empty status alone would conflate them).
  const tokens = await ctx.vault.get(ctx.tenant);
  const now = ctx.now();
  if (tokens === undefined) {
    return errorResult('No LinkedIn account is connected.', 'not-connected');
  }
  if (tokens.expiresAt <= now) {
    return errorResult('LinkedIn connection expired; reconnect to continue.', 'expired');
  }
  const decision = authorize({
    toolName: 'linkedin_get_my_profile',
    policy: PROFILE_POLICY,
    tenant: ctx.tenant,
    connection: { connected: true, scopes: tokens.scopes },
  });
  if (!decision.allow) {
    return errorResult(decision.message, decision.code);
  }
  // 2. The tenant's sealed token IS the identity source of truth.
  const accessToken = tokens.accessToken;
  // 3. Call the provider with the tenant's token — identity substitution
  //    is impossible: nothing from arguments reaches the request.
  let raw: unknown;
  try {
    raw = await ctx.provider.getUserInfo({ accessToken });
  } catch (err) {
    if (err instanceof ProviderError) {
      log.warn('userinfo provider error', { code: err.code, status: err.status ?? undefined });
      const message =
        err.code === 'timeout'
          ? 'LinkedIn did not respond in time; retry shortly.'
          : err.code === 'http-status' && err.status === 401
            ? 'LinkedIn rejected the access token (expired or revoked); reconnect.'
            : 'LinkedIn profile request failed.';
      return errorResult(message, `provider-${err.code}`);
    }
    log.error('unexpected profile error', { error: err instanceof Error ? err.message : String(err) });
    return errorResult('Unexpected error fetching profile.', 'internal');
  }
  // 4. Re-validate at the boundary (defense in depth: mock + real both
  //    validate, but the tool does not trust either).
  let info: ReturnType<typeof validateUserInfo>;
  try {
    info = validateUserInfo(raw);
  } catch (err) {
    if (err instanceof UserinfoValidationError) {
      log.warn('userinfo rejected at tool boundary', { field: err.field, reason: err.reason });
      return errorResult('LinkedIn returned an unexpected profile shape.', 'invalid-response');
    }
    throw err;
  }
  // 5. Serve only present, permitted fields — never invented.
  const view: ProfileView = { memberId: info.sub };
  if (info.name !== undefined) view.name = info.name;
  if (info.given_name !== undefined) view.givenName = info.given_name;
  if (info.family_name !== undefined) view.familyName = info.family_name;
  if (info.email !== undefined) view.email = info.email;
  if (info.email_verified !== undefined) view.emailVerified = info.email_verified;
  if (info.locale !== undefined) view.locale = info.locale;
  if (info.picture !== undefined) view.profilePictureUrl = info.picture;
  log.info('profile served', { member: info.sub, hasEmail: info.email !== undefined });
  return {
    content: [{ type: 'text', text: JSON.stringify(view) }],
    structuredContent: view as unknown as Record<string, unknown>,
  };
}

/**
 * Scope introspection tool result (no provider call — vault + token claim).
 * Honest representation: requested vs token-response claim vs unverified.
 */
export const SCOPE_TOOL_SPEC = {
  name: 'linkedin_list_granted_scopes',
  title: 'List requested vs granted LinkedIn scopes',
  description:
    'Reports the requested OAuth scopes, the scope claim captured at token exchange, which requested scopes are missing from that claim, and the verification level (token-response or unverified). LinkedIn self-serve provides no scope-introspection endpoint, so grants cannot be re-verified live; this reports what was captured at connect time.',
  inputSchema: z.object({}).strict(),
  policy: READ_ONLY,
} as const;

export async function listGrantedScopesTool(ctx: ToolContext): Promise<ToolResult> {
  const tokens = await ctx.vault.get(ctx.tenant);
  const report = buildScopeReport(tokens, ctx.now());
  const payload = {
    requestedScopes: report.requestedScopes,
    tokenScopeClaim: report.tokenScopeClaim,
    verification: report.verification,
    matchedFromClaim: report.matchedFromClaim,
    missingFromClaim: report.missingFromClaim,
    connectionState: report.connectionState,
    unverified: report.unverified,
    note: 'Granted scopes reflect the token-exchange response only; LinkedIn self-serve has no introspection endpoint to re-verify grants live.',
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
