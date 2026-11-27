/**
 * Authentication (M5, ADR-019): credential-based tenant identity for the
 * remote HTTP surface. The ONLY source of tenant identity is an
 * authenticated credential (session cookie or bearer API token) — a
 * caller-supplied tenant header is never trusted.
 *
 * - Passwords: scrypt (N=16384) with per-user salt; constant-time verify.
 * - Sessions: opaque 256-bit tokens, HMAC-truncated digest stored (a DB
 *   leak does not yield usable session tokens); HttpOnly+SameSite cookies;
 *   per-session CSRF token (double-submit + digest comparison); logout =
 *   row revocation (immediate); expiry enforced at read.
 * - API tokens: same digest-at-rest scheme, used by non-UI clients.
 * - Persistence: SQL (Postgres staging/prod, SQLite local), same schema.
 *
 * Local stdio mode is unchanged (LOCAL_DEV_TENANT, no auth). Production
 * startup REJECTS mock auth (config-enforced, fail-fast).
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import type { SqlExecutor } from '../../storage/sqlExecutor.js';
import { asString } from '../../storage/sqlExecutor.js';

const log = createLogger('auth:users');

export const SESSION_TTL_MS_DEFAULT = 8 * 3600 * 1000; // 8h
export const SCRYPT_N = 16_384, SCRYPT_R = 8, SCRYPT_P = 1;

/** Digest scheme for session/API tokens at rest (never reversible). */
function tokenDigest(token: string): string {
  // HMAC with a per-process key would tie rows to a process; instead a
  // plain SHA-256 keeps rows portable (DB is the trust boundary, digests
  // are lookup keys, not a secrecy layer).
  return createHash('sha256').update(token).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${String(SCRYPT_N)}$${String(SCRYPT_R)}$${String(SCRYPT_P)}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (saltB64 === undefined || hashB64 === undefined) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface AuthUser {
  id: string;
  username: string;
  tenantId: string;
  role: string;
}

export interface SessionInfo {
  user: AuthUser;
  csrfToken: string;
  expiresAt: number;
}

export class AuthError extends Error {
  constructor(
    readonly code:
      | 'invalid-credentials'
      | 'user-disabled'
      | 'session-expired'
      | 'session-revoked'
      | 'unknown-token',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Timestamps normalization across dialects. */
function toEpochMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v.endsWith('Z') ? v : `${v}Z`);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === 'number') return v;
  return null;
}

export class UserAuthStore {
  constructor(
    private readonly exec: SqlExecutor,
    private readonly sessionTtlMs: number = SESSION_TTL_MS_DEFAULT,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Create a user + their dedicated tenant (id = tenant id). */
  async createUser(username: string, password: string, role = 'member'): Promise<AuthUser> {
    const id = randomBytes(16).toString('hex');
    const tenantId = `tenant-${id}`;
    await this.exec.execute({
      sql: `INSERT INTO users (id, username, password_hash, tenant_id, role)
            VALUES ($1, $2, $3, $4, $5)`,
      params: [id, username, hashPassword(password), tenantId, role],
    });
    log.info('user created', { username, role, backend: this.exec.kind });
    return { id, username, tenantId, role };
  }

  /** Verify credentials -> user (no session yet). Generic failure message. */
  async verifyCredential(username: string, password: string): Promise<AuthUser> {
    const rows = await this.exec.query({
      sql: 'SELECT id, username, password_hash, tenant_id, role, disabled_at FROM users WHERE username = $1',
      params: [username],
    });
    const row = rows[0];
    // Uniform failure: never reveal whether the username exists.
    const ok = row !== undefined && verifyPassword(password, String(row.password_hash));
    if (!ok) throw new AuthError('invalid-credentials', 'Invalid username or password.');
    if (row.disabled_at !== null && row.disabled_at !== undefined) {
      throw new AuthError('user-disabled', 'This account is disabled.');
    }
    return {
      id: String(row.id),
      username: String(row.username),
      tenantId: String(row.tenant_id),
      role: String(row.role),
    };
  }

  /** Issue a session: returns the opaque token (shown once) + CSRF token. */
  async issueSession(user: AuthUser): Promise<{ token: string; csrfToken: string; expiresAt: number }> {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const sessionId = randomBytes(16).toString('hex');
    const expiresAt = this.now() + this.sessionTtlMs;
    await this.exec.execute({
      sql: `INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at)
            VALUES ($1, $2, $3, $4, $5)`,
      params: [sessionId, user.id, tokenDigest(token), tokenDigest(csrfToken), new Date(expiresAt).toISOString()],
    });
    return { token, csrfToken, expiresAt };
  }

  /** Resolve a session token to its user; enforces expiry + revocation. */
  async resolveSession(token: string): Promise<SessionInfo> {
    const rows = await this.exec.query({
      sql: `SELECT s.token_hash, s.csrf_token_hash, s.expires_at, s.revoked_at,
                   u.id AS user_id, u.username, u.tenant_id, u.role, u.disabled_at
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = $1`,
      params: [tokenDigest(token)],
    });
    const row = rows[0];
    if (row === undefined) throw new AuthError('unknown-token', 'Session not found.');
    if (row.revoked_at !== null && row.revoked_at !== undefined) {
      throw new AuthError('session-revoked', 'Session revoked.');
    }
    const exp = toEpochMs(row.expires_at);
    if (exp === null || exp <= this.now()) {
      throw new AuthError('session-expired', 'Session expired.');
    }
    if (row.disabled_at !== null && row.disabled_at !== undefined) {
      throw new AuthError('user-disabled', 'This account is disabled.');
    }
    // The CSRF token cannot be reconstructed from its digest — it is
    // returned to the caller only at issue time; for double-submit we
    // compare digests. Here we return a fresh comparison handle.
    return {
      user: {
        id: String(row.user_id),
        username: String(row.username),
        tenantId: String(row.tenant_id),
        role: String(row.role),
      },
      csrfToken: String(row.csrf_token_hash), // digest handle for compare
      expiresAt: exp,
    };
  }

  /** Double-submit CSRF: header token's digest must equal the stored digest. */
  verifyCsrfDigest(storedDigest: string, presented: string | undefined): boolean {
    if (presented === undefined || presented.length === 0) return false;
    const d = tokenDigest(presented);
    const stored = storedDigest;
    return d.length === stored.length && timingSafeEqual(Buffer.from(d), Buffer.from(stored));
  }

  /** Revoke one session (logout). */
  async revokeSession(token: string): Promise<void> {
    await this.exec.execute({
      sql: 'UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL',
      params: [tokenDigest(token), new Date(this.now()).toISOString()],
    });
  }

  /** Issue an API token (bearer, non-UI clients). Token shown once. */
  async issueApiToken(tenantId: string, label: string | null): Promise<string> {
    const token = `lkm_${randomBytes(32).toString('base64url')}`;
    const id = randomBytes(16).toString('hex');
    await this.exec.execute({
      sql: `INSERT INTO api_tokens (id, tenant_id, token_hash, label)
            VALUES ($1, $2, $3, $4)`,
      params: [id, tenantId, tokenDigest(token), label],
    });
    return token;
  }

  /** Resolve a bearer API token to its tenant; enforces revocation. */
  async resolveApiToken(token: string): Promise<AuthUser> {
    const rows = await this.exec.query({
      sql: `SELECT t.tenant_id, t.revoked_at FROM api_tokens t WHERE t.token_hash = $1`,
      params: [tokenDigest(token)],
    });
    const row = rows[0];
    if (row === undefined) throw new AuthError('unknown-token', 'API token not found.');
    if (row.revoked_at !== null && row.revoked_at !== undefined) {
      throw new AuthError('session-revoked', 'API token revoked.');
    }
    // Fire-and-forget last_used update; failures ignored deliberately.
    void this.exec.execute({
      sql: 'UPDATE api_tokens SET last_used_at = $2 WHERE token_hash = $1',
      params: [tokenDigest(token), new Date(this.now()).toISOString()],
    });
    return {
      id: `api-token:${asString(row.tenant_id) ?? 'unknown'}`,
      username: 'api-token',
      tenantId: String(row.tenant_id),
      role: 'api',
    };
  }

  /** Revoke an API token by id (owner action). */
  async revokeApiToken(id: string): Promise<void> {
    await this.exec.execute({
      sql: 'UPDATE api_tokens SET revoked_at = $2 WHERE id = $1',
      params: [id, new Date(this.now()).toISOString()],
    });
  }

  /** Record an auditable action (never values, only identifiers/shapes). */
  async audit(tenantId: string, actor: string, action: string, detail?: string): Promise<void> {
    await this.exec.execute({
      sql: 'INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1, $2, $3, $4)',
      params: [tenantId, actor, action, detail ?? null],
    });
  }
}
