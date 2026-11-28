import { createHash } from 'node:crypto';
/**
 * Real LinkedIn 3LO adapter. Calls the official endpoints with the pinned
 * self-serve scope set. Injected `fetch` keeps it testable without network
 * access; the production default is global fetch.
 */
import {
  LINKEDIN_AUTHORIZATION_ENDPOINT,
  LINKEDIN_POSTS_ENDPOINT,
  LINKEDIN_TOKEN_ENDPOINT,
  LINKEDIN_USERINFO_ENDPOINT,
  ProviderError,
  type AuthorizeUrlInput,
  type LinkedInOAuthProvider,
  type OAuthResult,
  type PublishInput,
  type TokenExchangeInput,
  type UserInfoInput,
  type UserInfoResponse,
} from './provider.js';
import type { TokenSet } from './tokenVault.js';
import { validateUserInfo, UserinfoValidationError } from './userinfoSchema.js';
import {
  validatePublishResult,
  PublishResultValidationError,
  type PublishResult,
} from './publishResult.js';

/** Default provider call timeout (ms). 401/403 from userinfo = revocation. */
export const USERINFO_TIMEOUT_MS = 10_000;
/** Default publication timeout (ms). Writes get a longer budget than reads. */
export const PUBLISH_TIMEOUT_MS = 30_000;
/**
 * Linkedin-Version header (YYYYMM). Pinned to the current documented
 * version at M4 time; retirement is a deliberate change (see ADR-015).
 * 202601 sunsets 2027-01-15 per the deprecation notice on the docs page.
 */
export const LINKEDIN_API_VERSION = '202611';

export class LinkedInRealProvider implements LinkedInOAuthProvider {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly userinfoTimeoutMs: number = USERINFO_TIMEOUT_MS,
    private readonly publishTimeoutMs: number = PUBLISH_TIMEOUT_MS,
  ) {}

  buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    const url = new URL(LINKEDIN_AUTHORIZATION_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', input.scopes.join(' '));
    // Issue #32 (PKCE): S256 challenge when a verifier is supplied —
    // binds the authorization code to this browser round-trip so an
    // intercepted code cannot be exchanged by a third party.
    if (input.codeVerifier !== undefined) {
      const challenge = createHash('sha256').update(input.codeVerifier).digest('base64url');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchangeCode(input: TokenExchangeInput): Promise<OAuthResult> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(LINKEDIN_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: input.redirectUri,
          client_id: input.clientId,
          client_secret: input.clientSecret,
          ...(input.codeVerifier !== undefined ? { code_verifier: input.codeVerifier } : {}),
        }).toString(),
      });
    } catch (err: unknown) {
      throw new ProviderError(
        'network',
        `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (resp.status !== 200) {
      // never include response body (may echo the code)
      throw new ProviderError('http-status', `token endpoint returned ${String(resp.status)}`, resp.status);
    }
    let parsed: {
      access_token?: string;
      expires_in?: number;
      scope?: string;
    };
    try {
      parsed = (await resp.json()) as typeof parsed;
    } catch {
      throw new ProviderError('invalid-response', 'token endpoint returned non-JSON body');
    }
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new ProviderError('invalid-response', 'token response missing access_token');
    }
    const expiresInS = typeof parsed.expires_in === 'number' ? parsed.expires_in : 5_184_000; // 60d LinkedIn default
    const tokens: TokenSet = {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + expiresInS * 1000,
      scopes: (parsed.scope ?? '').split(/[\s,]+/).filter((s) => s.length > 0),
    };
    return {
      ...tokens,
      // Member id resolution happens at callback time via getUserInfo()
      // when the profile capability first runs; until then 'pending'.
      memberId: 'pending',
    };
  }

  async getUserInfo(input: UserInfoInput): Promise<UserInfoResponse> {
    let resp: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.userinfoTimeoutMs);
    try {
      resp = await this.fetchImpl(LINKEDIN_USERINFO_ENDPOINT, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError('timeout', 'userinfo endpoint timed out');
      }
      throw new ProviderError(
        'network',
        `userinfo endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer); // eslint no-confusing-void: expression statement
    }
    if (resp.status === 401 || resp.status === 403) {
      // token expired/revoked or scopes insufficient: never echo the body
      throw new ProviderError('http-status', `userinfo returned ${String(resp.status)} (token expired/revoked or insufficient scope)`, resp.status);
    }
    if (resp.status !== 200) {
      throw new ProviderError('http-status', `userinfo endpoint returned ${String(resp.status)}`, resp.status);
    }
    let parsed: unknown;
    try {
      parsed = await resp.json();
    } catch {
      throw new ProviderError('invalid-response', 'userinfo endpoint returned non-JSON body');
    }
    try {
      return validateUserInfo(parsed);
    } catch (err) {
      if (err instanceof UserinfoValidationError) {
        // reason only — the offending value never leaves this module
        throw new ProviderError('invalid-response', `userinfo schema violation: ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Publish a text-only member post via POST /rest/posts (verified contract,
   * M4 Phase 2): required headers X-Restli-Protocol-Version 2.0.0 and
   * Linkedin-Version YYYYMM; author is urn:li:person:{sub} derived from the
   * authenticated identity, NEVER caller-supplied; success = 201 with the
   * post URN in x-restli-id. No automatic retry at this layer — a write
   * whose outcome is uncertain must surface as ambiguous, not be retried
   * (duplicate-post risk; ADR-016). 4xx is a definite refusal; 5xx, timeout
   * and network failure after send are ambiguous outcomes.
   */
  async publishPost(input: PublishInput): Promise<PublishResult> {
    // Request body exactly per the documented schema for a text-only post.
    const body = JSON.stringify({
      author: `urn:li:person:${input.memberSub}`,
      commentary: input.text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
    let resp: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.publishTimeoutMs);
    try {
      resp = await this.fetchImpl(LINKEDIN_POSTS_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          'x-restli-protocol-version': '2.0.0',
          'linkedin-version': LINKEDIN_API_VERSION,
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Timed out AFTER the request was sent: LinkedIn may have accepted
        // the post. This is the canonical ambiguous outcome.
        throw new ProviderError('timeout', 'posts endpoint timed out (outcome unknown)');
      }
      // Network failure mid-flight: the request may or may not have landed.
      throw new ProviderError(
        'network',
        `posts endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer); // eslint no-confusing-void: expression statement
    }
    // Read the URN from x-restli-id only; bodies are never echoed.
    const postUrn = resp.headers.get('x-restli-id') ?? undefined;
    if (resp.status === 201) {
      try {
        return validatePublishResult({ confirmed: true, postUrn, status: 201 });
      } catch (err) {
        if (err instanceof PublishResultValidationError) {
          throw new ProviderError('invalid-response', 'post creation response lacked a valid x-restli-id URN');
        }
        throw err;
      }
    }
    if (resp.status >= 400 && resp.status < 500) {
      // Definite refusal (400/401/403/409/422/429): no post was created.
      // 422 includes the documented exact-duplicate response; 429 is the
      // documented rate-limit response. Body never surfaces.
      throw new ProviderError('write-rejected', `posts endpoint refused the write (${String(resp.status)})`, resp.status);
    }
    // 5xx: LinkedIn did not confirm — but a gateway timeout on their side
    // may still have committed the write. Ambiguous, surfaced as such.
    throw new ProviderError('http-status', `posts endpoint returned ${String(resp.status)} (outcome unknown)`, resp.status);
  }
}
