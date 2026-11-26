/**
 * Real LinkedIn 3LO adapter. Calls the official endpoints with the pinned
 * self-serve scope set. Injected `fetch` keeps it testable without network
 * access; the production default is global fetch.
 */
import {
  LINKEDIN_AUTHORIZATION_ENDPOINT,
  LINKEDIN_TOKEN_ENDPOINT,
  LINKEDIN_USERINFO_ENDPOINT,
  ProviderError,
  type AuthorizeUrlInput,
  type LinkedInOAuthProvider,
  type OAuthResult,
  type TokenExchangeInput,
  type UserInfoInput,
  type UserInfoResponse,
} from './provider.js';
import type { TokenSet } from './tokenVault.js';
import { validateUserInfo, UserinfoValidationError } from './userinfoSchema.js';

/** Default provider call timeout (ms). 401/403 from userinfo = revocation. */
export const USERINFO_TIMEOUT_MS = 10_000;

export class LinkedInRealProvider implements LinkedInOAuthProvider {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly userinfoTimeoutMs: number = USERINFO_TIMEOUT_MS,
  ) {}

  buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    const url = new URL(LINKEDIN_AUTHORIZATION_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', input.scopes.join(' '));
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
      scopes: (parsed.scope ?? '').split(' ').filter((s) => s.length > 0),
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
}
