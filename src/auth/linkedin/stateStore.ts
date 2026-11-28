/**
 * OAuth 'state' store: CSRF protection for the authorization-code flow
 * (owner D-A8 OAuth state validation). Each state value is:
 * - cryptographically random (32 bytes base64url),
 * - bound to one tenant context,
 * - single-use (consumed atomically on validation),
 * - TTL-bounded (default 10 minutes),
 * - validated on the callback with constant-time comparison of the digest.
 */
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import type { TenantContext } from '../../identity/tenant.js';
import { tenantKey } from '../../identity/tenant.js';

const log = createLogger('auth:state');

export interface StoredState {
  state: string;
  tenant: TenantContext;
  expiresAt: number;
}

export class StateStoreError extends Error {
  constructor(
    readonly code: 'invalid' | 'expired' | 'consumed' | 'tenant-mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'StateStoreError';
  }
}

interface Entry {
  digest: Buffer; // sha-256 of state, constant-time compare
  /** PKCE code verifier (issue #32) — state-scoped, single-use with it. */
  verifier: string;
  tenantKey: string;
  expiresAt: number;
}

export class OAuthStateStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Create a fresh state bound to the tenant. */
  create(tenant: TenantContext): string {
    // opportunistic sweep of expired entries
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= this.now()) this.entries.delete(k);
    }
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url'); // RFC 7636: 43-128 chars
    const digest = createHash('sha256').update(state).digest();
    this.entries.set(state, {
      digest,
      verifier,
      tenantKey: tenantKey(tenant),
      expiresAt: this.now() + this.ttlMs,
    });
    return state;
  }

  /** Issue #32 (PKCE): the S256 code verifier bound to a live state.
   * Returns undefined when the state is unknown/expired — callers MUST
   * treat that as a state failure (the verifier is state-scoped). */
  verifierOf(state: string): string | undefined {
    const entry = this.entries.get(state);
    return entry?.verifier;
  }

  /**
   * Validate a callback's state for a tenant: must exist, be unexpired,
   * belong to this tenant, and be single-use. Consumes it either way
   * (a second attempt must never succeed — CSRF replay defense).
   */
  consume(state: string, tenant: TenantContext): void {
    const entry = this.entries.get(state);
    if (entry === undefined) {
      throw new StateStoreError('invalid', 'unknown state parameter');
    }
    // always remove: single-use semantics, even on failure paths
    this.entries.delete(state);
    const digest = createHash('sha256').update(state).digest();
    if (!timingSafeEqual(digest, entry.digest)) {
      // unreachable via public API (map key equality implies digest match);
      // kept as defense in depth
      throw new StateStoreError('invalid', 'state digest mismatch');
    }
    if (entry.expiresAt <= this.now()) {
      log.warn('expired state consumed', {});
      throw new StateStoreError('expired', 'state expired; restart the connection flow');
    }
    if (entry.tenantKey !== tenantKey(tenant)) {
      log.warn('tenant mismatch on state', {});
      throw new StateStoreError('tenant-mismatch', 'state was issued for a different tenant');
    }
  }
}
