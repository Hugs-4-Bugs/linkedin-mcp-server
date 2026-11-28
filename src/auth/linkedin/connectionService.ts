/**
 * Connection service: orchestrates the 3LO flow end to end.
 *
 * connect()      → state + authorize URL (rate-limited per tenant)
 * handleCallback() → consume state (single-use, tenant-bound), exchange code,
 *                    seal tokens in the vault
 * status()       → { connected, expiresAt, scopes, memberId }
 * disconnect()   → wipe the tenant's tokens (owner D-A8: disconnection)
 *
 * All tenant isolation flows from TenantContext; nothing here trusts tool
 * arguments for identity.
 */
import { createLogger } from '../../observability/logger.js';
import type { AppConfig } from '../../config/config.js';
import { LINKEDIN_SCOPES } from '../../config/config.js';
import type { TenantContext } from '../../identity/tenant.js';
import { OAuthStateStore, StateStoreError } from './stateStore.js';
import { NoTokenError, type TokenVault } from './tokenVault.js';
import type { LinkedInOAuthProvider } from './provider.js';
import { BucketRegistry } from '../../usage/tokenBucket.js';

const log = createLogger('auth:service');

/** Connect-flow rate limit: 6 attempts / 10 min / tenant (owner D-A8). */
const CONNECT_RATE = { capacity: 6, windowMs: 600_000 };

/**
 * State-store seam (M5, ADR-018): the M2 in-memory OAuthStateStore is
 * synchronous; the SQL-backed store is async. The service speaks this
 * narrow interface so either backend slots in without touching callers.
 */
export interface StateStorePort {
  create(tenant: TenantContext): string | Promise<string>;
  consume(state: string, tenant: TenantContext): void | Promise<void>;
}

export interface ConnectStart {
  authorizationUrl: string;
  /** Opaque flow id so the callback route can correlate without a session. */
  state: string;
}

export interface ConnectionStatusInfo {
  connected: boolean;
  expiresAt: number | null;
  scopes: readonly string[];
  memberId: string | null;
}

export class RateLimitError extends Error {
  constructor() {
    super('too many connect attempts; retry later');
    this.name = 'RateLimitError';
  }
}

export class CallbackError extends Error {
  constructor(
    readonly code: 'state' | 'provider',
    message: string,
  ) {
    super(message);
    this.name = 'CallbackError';
  }
}

export class LinkedInConnectionService {
  private readonly stateStore: StateStorePort;
  private readonly limiter: BucketRegistry;

  constructor(
    private readonly config: AppConfig,
    private readonly provider: LinkedInOAuthProvider,
    private readonly vault: TokenVault,
    private readonly now: () => number = () => Date.now(),
    stateStore: StateStorePort = new OAuthStateStore(
      (config.OAUTH_STATE_TTL_SECONDS) * 1000,
      now,
    ),
  ) {
    this.stateStore = stateStore;
    this.limiter = new BucketRegistry(CONNECT_RATE, now);
  }

  async connect(tenant: TenantContext): Promise<ConnectStart> {
    if (!this.limiter.for(`connect:${tenant.tenantId}/${tenant.userId}`).take()) {
      throw new RateLimitError();
    }
    const state = await this.stateStore.create(tenant);
    // Issue #32 (PKCE): the S256 verifier travels with the state entry;
    // the authorize URL carries only the derived challenge.
    const codeVerifier =
      this.stateStore instanceof OAuthStateStore ? this.stateStore.verifierOf(state) : undefined;
    const authorizationUrl = this.provider.buildAuthorizeUrl({
      clientId: this.clientId(),
      redirectUri: this.config.LINKEDIN_REDIRECT_URI ?? 'http://127.0.0.1/mock-callback',
      state,
      scopes: LINKEDIN_SCOPES,
      ...(codeVerifier !== undefined ? { codeVerifier } : {}),
    });
    log.info('connect flow started', { tenant: tenant.tenantId });
    return { authorizationUrl, state };
  }

  /**
   * OAuth callback: validate + consume state for this tenant, exchange code,
   * store sealed tokens. Never logs the code.
   */
  async handleCallback(tenant: TenantContext, state: string, code: string): Promise<ConnectionStatusInfo> {
    // Issue #32 (PKCE): lift the verifier BEFORE consume() deletes the
    // entry (single-use semantics) — it must accompany the token exchange.
    const codeVerifier =
      this.stateStore instanceof OAuthStateStore ? this.stateStore.verifierOf(state) : undefined;
    try {
      await this.stateStore.consume(state, tenant);
    } catch (err) {
      if (err instanceof StateStoreError) {
        throw new CallbackError('state', err.message);
      }
      throw err;
    }
    const result = await this.provider.exchangeCode({
      clientId: this.clientId(),
      clientSecret: this.config.LINKEDIN_CLIENT_SECRET ?? 'mock-secret',
      redirectUri: this.config.LINKEDIN_REDIRECT_URI ?? 'http://127.0.0.1/mock-callback',
      code,
      ...(codeVerifier !== undefined ? { codeVerifier } : {}),
    });
    await this.vault.put(tenant, {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      scopes: result.scopes,
      memberSub: result.memberId,
    });
    log.info('callback accepted; tokens sealed', { tenant: tenant.tenantId, scopes: result.scopes.join(' ') });
    return {
      connected: true,
      expiresAt: result.expiresAt,
      scopes: result.scopes,
      memberId: result.memberId,
    };
  }

  async status(tenant: TenantContext): Promise<ConnectionStatusInfo> {
    let tokens;
    try {
      tokens = await this.vault.get(tenant);
    } catch {
      // Corrupt/unreadable entry is treated as disconnected, never surfaced raw.
      log.warn('vault read failed; treating as disconnected', { tenant: tenant.tenantId });
      return { connected: false, expiresAt: null, scopes: [], memberId: null };
    }
    if (tokens === undefined) {
      return { connected: false, expiresAt: null, scopes: [], memberId: null };
    }
    const expired = tokens.expiresAt <= this.now();
    return {
      connected: !expired,
      expiresAt: expired ? null : tokens.expiresAt,
      scopes: tokens.scopes,
      memberId: expired ? null : tokens.memberSub ?? null,
    };
  }

  async disconnect(tenant: TenantContext): Promise<boolean> {
    try {
      await this.vault.delete(tenant);
      return true;
    } catch (err) {
      if (err instanceof NoTokenError) return false;
      throw err;
    }
  }

  /** Client id for the active provider (mock ids are fine for the mock). */
  private clientId(): string {
    return this.config.LINKEDIN_CLIENT_ID ?? 'mock-client-id';
  }
}
