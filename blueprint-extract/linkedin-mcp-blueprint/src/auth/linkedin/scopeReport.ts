/**
 * Granted-scope verification (M3, owner requirement §3).
 *
 * Truth model — LinkedIn's self-serve OAuth v2 has NO introspection or
 * tokeninfo endpoint, and the accessToken response is not readable to us
 * after exchange (LinkedIn returns the scope string on the token exchange,
 * which M2 stores). So:
 *
 * - `requestedScopes`: what we asked for at authorize time (fixed set).
 * - `tokenScopeClaim`: the scope string from our own token-exchange response
 *   (what LinkedIn's token endpoint said at exchange time). For the mock
 *   provider this is simulated; for the real provider it is whatever the
 *   token endpoint returned, normalized. This is the ONLY granted-scope
 *   signal available without a verified introspection mechanism, and it is
 *   *point-in-time* (exchange moment), not continuously verifiable.
 * - `verification`: 'token-response' (claim came from the token exchange) or
 *   'unverified' (no claim captured — e.g. token response omitted scope).
 *
 * The representation explicitly separates these and NEVER equates requested
 * with granted. Consumers (tools, tests) must treat the claim as best-effort
 * evidence, not proof of live permission.
 */
import { LINKEDIN_SCOPES } from '../../config/config.js';
import type { TokenSet } from './tokenVault.js';

export type ScopeVerification = 'token-response' | 'unverified';

export interface ScopeReport {
  /** Scopes requested at authorization time (fixed self-serve set). */
  requestedScopes: readonly string[];
  /**
   * Scopes LinkedIn's token endpoint reported at exchange time, when it
   * reported any. Empty array + verification='unverified' when unknown.
   * NOT proof of current grants — LinkedIn self-serve has no introspection
   * endpoint we can call to re-verify (documented limitation, not a guess).
   */
  tokenScopeClaim: readonly string[];
  verification: ScopeVerification;
  /** Requested scopes absent from the claim (when claim exists). */
  missingFromClaim: readonly string[];
  /** Requested scopes present in the claim. */
  matchedFromClaim: readonly string[];
  connectionState: 'connected' | 'disconnected' | 'expired';
  /** True when the stored token set carries no usable claim. */
  unverified: boolean;
}

export function buildScopeReport(
  tokens: TokenSet | undefined,
  now: number,
  requested: readonly string[] = LINKEDIN_SCOPES,
): ScopeReport {
  if (tokens === undefined) {
    return {
      requestedScopes: requested,
      tokenScopeClaim: [],
      verification: 'unverified',
      missingFromClaim: [...requested],
      matchedFromClaim: [],
      connectionState: 'disconnected',
      unverified: true,
    };
  }
  const expired = tokens.expiresAt <= now;
  const claimed = tokens.scopes.filter((s) => requested.includes(s));
  const claimKnown = tokens.scopes.length > 0;
  return {
    requestedScopes: requested,
    // claim restricted to the requested set; foreign scopes would be
    // unexpected and are surfaced in nothing — they're not ours to interpret
    tokenScopeClaim: claimKnown ? [...tokens.scopes] : [],
    verification: claimKnown ? 'token-response' : 'unverified',
    missingFromClaim: claimKnown
      ? requested.filter((s) => !tokens.scopes.includes(s))
      : [...requested],
    matchedFromClaim: claimKnown ? claimed : [],
    connectionState: expired ? 'expired' : 'connected',
    unverified: !claimKnown,
  };
}
