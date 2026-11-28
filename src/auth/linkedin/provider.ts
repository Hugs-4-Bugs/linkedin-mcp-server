/**
 * LinkedIn OAuth provider contract (the M2 seam between our service layer
 * and LinkedIn's real 3LO endpoints vs the mock used in tests/local).
 *
 * Real endpoints (verified against Microsoft Learn, M4 Phase 2 re-check:
 * "Sign In with LinkedIn using OpenID Connect", "Posts API", "UGC Post API"):
 *  - authorize: https://www.linkedin.com/oauth/v2/authorization
 *  - token:     https://www.linkedin.com/oauth/v2/accessToken
 *  - userinfo:  https://api.linkedin.com/v2/userinfo (OIDC)
 *  - posts:     https://api.linkedin.com/rest/posts (Posts API; w_member_social,
 *               headers X-Restli-Protocol-Version 2.0.0 + Linkedin-Version
 *               YYYYMM; 201 with the post URN in the x-restli-id header)
 * Scopes are the fixed self-serve set (ADR-012). Access tokens last 60 days;
 * refresh tokens are partner-only, so expiry handling is explicit.
 *
 * Rate limits (M4 Phase 2 finding): LinkedIn publishes NO numeric per-member
 * or per-app quota in documentation; actual limits are surfaced per-app in
 * the Developer Portal Analytics. The earlier "150 req/member/day" note was
 * community folklore, not documentation — it is therefore an application
 * safety limit, never a claimed LinkedIn quota (ADR-015).
 */
import type { TokenSet } from './tokenVault.js';
import type { PublishResult } from './publishResult.js';

export const LINKEDIN_AUTHORIZATION_ENDPOINT =
  'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_TOKEN_ENDPOINT = 'https://www.linkedin.com/oauth/v2/accessToken';
export const LINKEDIN_USERINFO_ENDPOINT = 'https://api.linkedin.com/v2/userinfo';
export const LINKEDIN_POSTS_ENDPOINT = 'https://api.linkedin.com/rest/posts';

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: readonly string[];
  /** PKCE verifier (S256). Optional for backward compatibility; when
   * present the authorize URL carries the derived code_challenge. */
  codeVerifier?: string;
}

export interface TokenExchangeInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  /** PKCE verifier — MUST match the challenge sent at authorize time. */
  codeVerifier?: string;
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
  /**
   * Publish a text-only post to the authenticated member's feed via the
   * Posts API (POST /rest/posts). The author is the identity bound to the
   * sealed access token — callers never supply an author URN. Returns the
   * verified outcome: confirmed (201 + x-restli-id URN), refused (4xx), or
   * ambiguous (timeout/network/5xx — the provider could not determine
   * whether LinkedIn accepted it). Throws ProviderError only for transport
   * classification; response bodies never leak into logs or errors.
   */
  publishPost(input: PublishInput): Promise<PublishResult>;
}

export interface PublishInput {
  /** Sealed access token for the connected tenant. */
  accessToken: string;
  /** Member sub (OIDC subject) — becomes urn:li:person:{sub} as author. */
  memberSub: string;
  /** Already-validated post text (validatePostText ran at the tool layer). */
  text: string;
  /** Injectable clock for deterministic mock/TTL behavior. */
  now?: () => number;
}

export type ProviderErrorCode =
  | 'invalid-grant'
  | 'network'
  | 'invalid-response'
  | 'http-status'
  | 'timeout'
  /** Write refused by the provider before/at submission (4xx). */
  | 'write-rejected';

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
