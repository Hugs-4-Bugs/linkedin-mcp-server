/**
 * Tool context: what every registered tool receives besides its arguments.
 * Keeps identity/policy plumbing out of tool bodies.
 */
import type { AppConfig } from '../config/config.js';
import type { TenantContext } from '../identity/tenant.js';
import type { LinkedInConnectionService } from '../auth/linkedin/connectionService.js';
import type { LinkedInOAuthProvider } from '../auth/linkedin/provider.js';
import type { TokenBucket } from '../usage/tokenBucket.js';
import { NoTokenError, type TokenVault } from '../auth/linkedin/tokenVault.js';
import type { PostOperationStore } from '../auth/linkedin/postOperationStore.js';
import type { SqlPostOperationStore, SqlPublishBudget } from '../auth/linkedin/sqlPublishStores.js';

export interface ToolContext {
  config: AppConfig;
  tenant: TenantContext;
  connection: LinkedInConnectionService;
  /** LinkedIn-call budget for this tenant (M4 tools consume from it). */
  callBudget: TokenBucket;
  vault: TokenVault;
  /** OAuth provider (for provider-backed capabilities like userinfo). */
  provider: LinkedInOAuthProvider;
  /** Publication operation ledger (M4 duplicate/write safety, ADR-016). */
  postOps: PostOperationStore | SqlPostOperationStore;
  /** SQL publish budget when persistence is active (ADR-018). */
  publishBudgetSql?: SqlPublishBudget | undefined;
  /** Daily publication budget for this tenant (app safety limit, ADR-015). */
  publishBudget: TokenBucket;
  /** Time source; injectable for deterministic expiry tests. */
  now: () => number;
  /**
   * Audit sink (M7 issues #12/#16): tool name + outcome, NEVER payloads or
   * arguments. Undefined in local stdio mode; SQL audit rows in remote
   * mode (wired in serverFactory.toolContext).
   */
  auditSink?: ((tool: string, outcome: 'ok' | 'error') => Promise<void>) | undefined;
}

/** Fetch the decrypted token for a tenant or throw a typed error. */
export async function requireAccessToken(ctx: ToolContext): Promise<string> {
  const tokens = await ctx.vault.get(ctx.tenant);
  if (tokens === undefined || tokens.expiresAt <= ctx.now()) {
    throw new NoTokenError();
  }
  return tokens.accessToken;
}
