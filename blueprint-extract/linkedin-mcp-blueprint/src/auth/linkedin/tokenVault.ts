/**
 * Token vault (ADR-008): envelope-encrypted storage of LinkedIn tokens.
 *
 * This module defines the storage contract and AES-256-GCM encryption
 * helpers. In-memory `InMemoryTokenVault` backs local dev + tests; the
 * Postgres-backed vault arrives with the storage milestone (M5 hosting).
 * Ciphertext never leaves this module in plaintext form; keys are
 * validated 32-byte buffers (base64 from config).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import type { TenantContext } from '../../identity/tenant.js';
import { tenantKey } from '../../identity/tenant.js';

const log = createLogger('auth:vault');

export interface TokenSet {
  accessToken: string;
  /** Unix epoch ms when the token expires (LinkedIn: 60 days). */
  expiresAt: number;
  scopes: readonly string[];
  /**
   * Authenticated member's OIDC sub (M4): the identity that authorship is
   * bound to. Mock provider resolves it at exchange; the real provider
   * marks it 'pending' until a live userinfo call confirms the sub — tools
   * must refuse writes that need a definite author while it is unresolved.
   */
  memberSub?: string;
}

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultKeyError';
  }
}

/** Parse a base64 32-byte key; throws VaultKeyError otherwise. */
export function parseVaultKey(b64: string): Buffer {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    throw new VaultKeyError(`TOKEN_VAULT_KEY must decode to 32 bytes, got ${String(buf.length)}`);
  }
  return buf;
}

/** Generate a fresh base64 master key (for local dev when unset). */
export function generateVaultKey(): string {
  return randomBytes(32).toString('base64');
}

interface Sealed {
  iv: string; // base64, 12 bytes
  ct: string; // base64 ciphertext+tag
}

function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), ct: Buffer.concat([ct, tag]).toString('base64') };
}

function unseal(key: Buffer, sealed: Sealed): string {
  const raw = Buffer.from(sealed.ct, 'base64');
  const ct = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Thrown on get() when no token set exists for the tenant. */
export class NoTokenError extends Error {
  constructor() {
    super('no LinkedIn token stored for tenant');
    this.name = 'NoTokenError';
  }
}

export interface TokenVault {
  put(tenant: TenantContext, tokens: TokenSet): Promise<void>;
  get(tenant: TenantContext): Promise<TokenSet | undefined>;
  delete(tenant: TenantContext): Promise<void>;
}

export class InMemoryTokenVault implements TokenVault {
  private readonly store = new Map<string, Sealed>();

  constructor(masterKeyBase64: string) {
    parseVaultKey(masterKeyBase64); // fail fast on bad key shape
    this.key = parseVaultKey(masterKeyBase64);
  }

  private readonly key: Buffer;

  async put(tenant: TenantContext, tokens: TokenSet): Promise<void> {
    await Promise.resolve(); // async by contract (Postgres vault arrives M5)
    const plaintext = JSON.stringify(tokens);
    this.store.set(tenantKey(tenant), seal(this.key, plaintext));
    log.info('token set stored', { tenant: tenant.tenantId, scopes: tokens.scopes.join(' ') });
  }

  async get(tenant: TenantContext): Promise<TokenSet | undefined> {
    await Promise.resolve(); // async by contract (Postgres vault arrives M5)
    const sealed = this.store.get(tenantKey(tenant));
    if (sealed === undefined) return undefined;
    const parsed = JSON.parse(unseal(this.key, sealed)) as TokenSet;
    return parsed;
  }

  async delete(tenant: TenantContext): Promise<void> {
    await Promise.resolve(); // async by contract (Postgres vault arrives M5)
    const existed = this.store.delete(tenantKey(tenant));
    if (existed) log.info('token set deleted', { tenant: tenant.tenantId });
  }
}
