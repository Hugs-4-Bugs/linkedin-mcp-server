/**
 * Mock LinkedIn OAuth provider (owner M2 directive: mock providers/tests so
 * the OAuth foundation is implemented and verified without credentials).
 *
 * Behaves like LinkedIn's 3LO shape:
 * - builds a real-shaped authorization URL,
 * - accepts only codes it issued (any other code → invalid-grant),
 * - `autoApprove` mode returns a deterministic code immediately via
 *   `issueCode()` — tests and the local dev flow drive the full loop.
 */
import {
  LINKEDIN_AUTHORIZATION_ENDPOINT,
  ProviderError,
  type AuthorizeUrlInput,
  type LinkedInOAuthProvider,
  type OAuthResult,
  type TokenExchangeInput,
} from './provider.js';
import { randomBytes } from 'node:crypto';

export interface MockApprover {
  /** Deterministic fake member identity for the mock connection. */
  memberId?: string;
}

export class LinkedInMockProvider implements LinkedInOAuthProvider {
  private readonly issued = new Map<string, { memberId: string; scopes: readonly string[] }>();
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
    return {
      accessToken: `mock-token-${randomBytes(16).toString('hex')}`,
      expiresAt: Date.now() + 60 * 24 * 3600 * 1000, // 60-day shape
      scopes: entry.scopes,
      memberId: entry.memberId,
    };
  }

  /** Test hook: number of codes issued so far. */
  issuedCount(): number {
    return this.issued.size + this.counter;
  }
}
