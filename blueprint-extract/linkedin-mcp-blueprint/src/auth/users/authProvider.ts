/**
 * AuthProvider abstraction (M5, ADR-019): how the HTTP layer learns the
 * authenticated tenant for a request. Two implementations:
 *
 *  - SessionAuthProvider (real): cookie session or bearer API token via
 *    the SQL UserAuthStore. Tenant identity comes ONLY from the validated
 *    credential. Used in local HTTP dev AND staging/prod.
 *  - MockAuthProvider (deterministic tests only): a fixed credential
 *    mapping. CONFIG-REJECTED in production startup (fail-fast).
 *
 * Local stdio does not use any provider (LOCAL_DEV_TENANT directly).
 */
import type { SessionInfo, AuthUser } from './userAuthStore.js';
import { AuthError } from './userAuthStore.js';

export interface RequestCredential {
  /** Raw cookie value when present (session token). */
  cookieToken?: string | undefined;
  /** Raw Authorization: Bearer value when present (API token). */
  bearerToken?: string | undefined;
}

export interface AuthenticatedRequest {
  tenantId: string;
  /** 'session' (UI, CSRF rules apply) | 'bearer' (API client). */
  via: 'session' | 'bearer';
  user?: AuthUser | undefined;
  session?: SessionInfo | undefined;
}

export abstract class AuthProvider {
  /** Authenticate one request; throws AuthError on failure. */
  abstract authenticate(cred: RequestCredential): Promise<AuthenticatedRequest>;
}

export class SessionAuthProvider extends AuthProvider {
  constructor(
    private readonly store: import('./userAuthStore.js').UserAuthStore,
  ) {
    super();
  }

  async authenticate(cred: RequestCredential): Promise<AuthenticatedRequest> {
    if (cred.bearerToken !== undefined && cred.bearerToken.length > 0) {
      const user = await this.store.resolveApiToken(cred.bearerToken);
      return { tenantId: user.tenantId, via: 'bearer', user };
    }
    if (cred.cookieToken !== undefined && cred.cookieToken.length > 0) {
      const session = await this.store.resolveSession(cred.cookieToken);
      return {
        tenantId: session.user.tenantId,
        via: 'session',
        user: session.user,
        session,
      };
    }
    throw new AuthError('unknown-token', 'Authentication required.');
  }
}

/** Deterministic fixed-identity provider — TESTS ONLY (config-gated). */
export class MockAuthProvider extends AuthProvider {
  constructor(private readonly fixedTenantId: string) {
    super();
  }

  authenticate(cred: RequestCredential): Promise<AuthenticatedRequest> {
    if (cred.bearerToken === 'mock-admin-token' || cred.cookieToken === 'mock-admin-token') {
      return Promise.resolve({ tenantId: this.fixedTenantId, via: 'bearer' });
    }
    return Promise.reject(new AuthError('unknown-token', 'Authentication required.'));
  }
}
