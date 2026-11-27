/**
 * Persistent token vault (M5, ADR-018): the SAME TokenVault contract as the
 * M2 in-memory vault, backed by SQL. The DB stores ONLY the AES-256-GCM
 * sealed envelope (iv + ciphertext+tag) — it never sees a plaintext access
 * token. Tenant binding is the primary key; no query can read another
 * tenant's row without the tenant id being the literal lookup key.
 */
import { parseVaultKey, seal, unseal } from './tokenVault.js';
import type { TokenSet, TokenVault } from './tokenVault.js';
import type { TenantContext } from '../../identity/tenant.js';
import { tenantKey } from '../../identity/tenant.js';
import type { SqlExecutor } from '../../storage/sqlExecutor.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('auth:vault:db');

export class SqlTokenVault implements TokenVault {
  private readonly key: Buffer;

  constructor(
    private readonly exec: SqlExecutor,
    masterKeyBase64: string,
  ) {
    this.key = parseVaultKey(masterKeyBase64); // fail fast on bad key shape
  }

  async put(tenant: TenantContext, tokens: TokenSet): Promise<void> {
    const plaintext = JSON.stringify(tokens);
    const s = seal(this.key, plaintext);
    await this.exec.execute({
      sql: `INSERT INTO linkedin_tokens (tenant_id, ciphertext, iv, auth_tag, expires_at, scopes, member_sub, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (tenant_id) DO UPDATE SET
              ciphertext = excluded.ciphertext,
              iv = excluded.iv,
              auth_tag = excluded.auth_tag,
              expires_at = excluded.expires_at,
              scopes = excluded.scopes,
              member_sub = excluded.member_sub,
              updated_at = excluded.updated_at`,
      params: [
        tenantKey(tenant),
        s.ct,
        s.iv,
        // tag lives inside ct; stored separately for schema clarity
        s.ct.slice(-24), // last 16 bytes b64 ≈ 24 chars (tag)
        tokens.expiresAt,
        tokens.scopes.join(' '),
        tokens.memberSub ?? null,
        new Date().toISOString(),
      ],
    });
    log.info('token set stored', { tenant: tenant.tenantId, scopes: tokens.scopes.join(' '), backend: this.exec.kind });
  }

  async get(tenant: TenantContext): Promise<TokenSet | undefined> {
    const rows = await this.exec.query({
      sql: `SELECT ciphertext, iv, expires_at, scopes, member_sub
            FROM linkedin_tokens WHERE tenant_id = $1`,
      params: [tenantKey(tenant)],
    });
    const row = rows[0];
    if (row === undefined) return undefined;
    const sealed = { iv: String(row.iv), ct: String(row.ciphertext) };
    const parsed = JSON.parse(unseal(this.key, sealed)) as TokenSet;
    // expiresAt/memberSub also live in columns (queryable without decrypt);
    // the sealed payload remains the source of truth for the token itself.
    return parsed;
  }

  async delete(tenant: TenantContext): Promise<void> {
    const n = await this.exec.execute({
      sql: 'DELETE FROM linkedin_tokens WHERE tenant_id = $1',
      params: [tenantKey(tenant)],
    });
    if (n > 0) log.info('token set deleted', { tenant: tenant.tenantId, backend: this.exec.kind });
  }
}
