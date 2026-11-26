/**
 * Mock LinkedIn OAuth provider (owner M2 directive: mock providers/tests so
 * the OAuth foundation is implemented and verified without credentials).
 *
 * Behaves like LinkedIn's 3LO shape:
 * - builds a real-shaped authorization URL,
 * - accepts only codes it issued (any other code → invalid-grant),
 * - `issueCode()` returns a deterministic code; tests and local dev drive
 *   the full loop,
 * - `getUserInfo` returns deterministic fixtures for tokens it minted —
 *   and rejects unknown/foreign tokens exactly like the real endpoint
 *   would (401 shape).
 */
import {
  LINKEDIN_AUTHORIZATION_ENDPOINT,
  ProviderError,
  type AuthorizeUrlInput,
  type LinkedInOAuthProvider,
  type OAuthResult,
  type TokenExchangeInput,
  type UserInfoInput,
  type UserInfoResponse,
} from './provider.js';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { validateUserInfo } from './userinfoSchema.js';

export interface MockApprover {
  /** Deterministic fake member identity for the mock connection. */
  memberId?: string;
  /**
   * Fixture userinfo the mock serves for tokens it minted. Must itself pass
   * validateUserInfo — the mock is not allowed to serve shapes the real API
   * would reject. When unset, a canonical fixture derived from the member
   * id is served.
   */
  userinfo?: UserInfoResponse;
}

/** Canonical deterministic fixture for a mock member id. */
export function defaultMockUserinfo(memberId: string): UserInfoResponse {
  return {
    sub: memberId,
    name: `Mock Member (${memberId})`,
    given_name: 'Mock',
    family_name: 'Member',
    email: `${memberId}@example.invalid`,
    email_verified: true,
    locale: { language: 'en', country: 'US' },
    picture: `https://example.invalid/pictures/${memberId}.png`,
  };
}

/** Binds a token to its member so getUserInfo can look it up. */
interface MintedToken {
  memberId: string;
  scopes: readonly string[];
}

export class LinkedInMockProvider implements LinkedInOAuthProvider {
  private readonly issued = new Map<string, { memberId: string; scopes: readonly string[] }>();
  private readonly minted = new Map<string, MintedToken>();
  private counter = 0;

  constructor(private readonly options: MockApprover = {}) {}

  buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    const url = new URL(LINKEDIN_AUTHORIZATION_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('mock', '1');
    return url.toString();
  }

  /** Simulates the user approving: returns the auth code the callback gets. */
  issueCode(scopes: readonly string[]): string {
    this.counter += 1;
    const code = `mock-code-${String(this.counter).padStart(4, '0')}-${randomBytes(4).toString('hex')}`;
    this.issued.set(code, {
      memberId: this.options.memberId ?? `mock-member-${String(this.counter)}`,
      scopes,
    });
    return code;
  }

  async exchangeCode(input: TokenExchangeInput): Promise<OAuthResult> {
    await Promise.resolve(); // async by contract (real provider is networked)
    const entry = this.issued.get(input.code);
    if (entry === undefined) {
      throw new ProviderError('invalid-grant', 'mock provider: unknown or already-used code');
    }
    this.issued.delete(input.code); // single-use codes
    this.counter += 1;
    const token = `mock-token-${randomBytes(16).toString('hex')}`;
    this.minted.set(token, { memberId: entry.memberId, scopes: entry.scopes });
    return {
      accessToken: token,
      expiresAt: Date.now() + 60 * 24 * 3600 * 1000, // 60-day shape
      scopes: entry.scopes,
      memberId: entry.memberId,
    };
  }

  async getUserInfo(input: UserInfoInput): Promise<UserInfoResponse> {
    await Promise.resolve(); // async by contract (real provider is networked)
    const minted = this.minted.get(input.accessToken);
    if (minted === undefined) {
      // unknown or foreign (real-provider) token: 401 shape, no echo
      throw new ProviderError('http-status', 'mock userinfo: token not issued by mock provider', 401);
    }
    const fixture = this.options.userinfo ?? defaultMockUserinfo(minted.memberId);
    const fixed = { ...fixture, sub: minted.memberId };
    // the mock must never serve an invalid shape itself
    return validateUserInfo(fixed);
  }

  /** Test hook: tokens minted but not yet used, by hash prefix. */
  mintedCount(): number {
    return this.minted.size;
  }

  /** Test hook: number of codes issued so far. */
  issuedCount(): number {
    return this.issued.size + this.counter;
  }

  /** Stable test hook: hash a token for assertions without printing it. */
  static tokenFingerprint(token: string): string {
    return createHash('sha256').update(token).digest('base64url').slice(0, 12);
  }
}
