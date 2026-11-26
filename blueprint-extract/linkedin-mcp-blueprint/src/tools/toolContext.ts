/**
 * Tool context: what every registered tool receives besides its arguments.
 * Keeps identity/policy plumbing out of tool bodies.
 */
import type { AppConfig } from '../config/config.js';
import type { TenantContext } from '../identity/tenant.js';
import type { LinkedInConnectionService } from '../auth/linkedin/connectionService.js';
import type { TokenBucket } from '../usage/tokenBucket.js';
import { NoTokenError, type TokenVault } from '../auth/linkedin/tokenVault.js';

export interface ToolContext {
  config: AppConfig;
  tenant: TenantContext;
  connection: LinkedInConnectionService;
  /** LinkedIn-call budget for this tenant (M4 tools consume from it). */
  callBudget: TokenBucket;
  vault: TokenVault;
}

/** Fetch the decrypted token for a tenant or throw a typed error. */
export async function requireAccessToken(ctx: ToolContext): Promise<string> {
  const tokens = await ctx.vault.get(ctx.tenant);
  if (tokens === undefined || tokens.expiresAt <= Date.now()) {
    throw new NoTokenError();
  }
  return tokens.accessToken;
}
