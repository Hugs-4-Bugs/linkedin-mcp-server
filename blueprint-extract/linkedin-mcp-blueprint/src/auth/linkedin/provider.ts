/**
 * LinkedIn OAuth provider contract (the M2 seam between our service layer
 * and LinkedIn's real 3LO endpoints vs the mock used in tests/local).
 *
 * Real endpoints (Phase 0 research, Microsoft Learn "Sign In with LinkedIn
 * using OpenID Connect" + docs for Share on LinkedIn):
 *  - authorize: https://www.linkedin.com/oauth/v2/authorization
 *  - token:     https://www.linkedin.com/oauth/v2/accessToken
 *  - userinfo: https://api.linkedin.com/v2/userinfo (OIDC)
 * Scopes are the fixed self-serve set (ADR-012). Access tokens last 60 days;
 * refresh tokens are partner-only, so expiry handling is explicit.
 */
import type { TokenSet } from './tokenVault.js';

export const LINKEDIN_AUTHORIZATION_ENDPOINT =
  'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_TOKEN_ENDPOINT = 'https://www.linkedin.com/oauth/v2/accessToken';
export const LINKEDIN_USERINFO_ENDPOINT = 'https://api.linkedin.com/v2/userinfo';

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: readonly string[];
}

export interface TokenExchangeInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}

export interface OAuthResult extends TokenSet {
  /** Stable member identifier from the provider (sub for OIDC). */
  memberId: string;
}

/**
 * OIDC userinfo response (LinkedIn "Sign In with LinkedIn using OpenID
 * Connect", Microsoft Learn). Only the fields in the fixed self-serve scope
 * set are permitted here; anything else in the response body is REJECTED,
 * not silently dropped: profile, email, email_verified, name (derived from
 * locale variants), given_name, family_name, locale, picture, sub.
 */
export interface UserInfoResponse {
  sub: string;
  name?: string | undefined;
  given_name?: string | undefined;
  family_name?: string | undefined;
  email?: string | undefined;
  email_verified?: boolean | undefined;
  locale?: { language: string; country?: string | undefined } | undefined;
  picture?: string | undefined;
}

export interface UserInfoInput {
  /** Sealed access token for the connected tenant. */
  accessToken: string;
}

export interface LinkedInOAuthProvider {
  /** Build the user-facing authorization URL. */
  buildAuthorizeUrl(input: AuthorizeUrlInput): string;
  /**
   * Exchange the authorization code for tokens. Throws ProviderError with a
   * code on failure; never logs the code or tokens.
   */
  exchangeCode(input: TokenExchangeInput): Promise<OAuthResult>;
  /**
   * Fetch the authenticated member's OIDC userinfo using the tenant's
   * sealed access token (the caller's identity comes from the token, never
   * from tool arguments). Throws ProviderError on failure; response bodies
   * never leak into logs or errors.
   */
  getUserInfo(input: UserInfoInput): Promise<UserInfoResponse>;
}

export type ProviderErrorCode =
  | 'invalid-grant'
  | 'network'
  | 'invalid-response'
  | 'http-status'
  | 'timeout';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
