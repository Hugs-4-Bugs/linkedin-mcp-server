/**
 * Migrations (M5, ADR-018): one ordered list of schema steps, applied to
 * both Postgres and SQLite. Dialect differences are confined to type names
 * in each step's two variants. Migration state persists in
 * schema_migrations; apply() is idempotent and safe to run at startup.
 *
 * Every tenant-owned table carries a `tenant_id` column and every query in
 * the persistent stores filters by it — tenant isolation is enforced at
 * the storage boundary, not only at the service boundary.
 *
 * Encryption: tokens are sealed by the SAME AES-256-GCM envelope as M2–M4
 * before insertion (the vault encrypts; the DB stores ciphertext). The
 * DB never sees plaintext access tokens; encryption keys come from env
 * (TOKEN_VAULT_KEY), never from the DB.
 */
import type { SqlExecutor } from './sqlExecutor.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('storage:migrations');

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly postgres: readonly string[];
  readonly sqlite: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'core tables',
    postgres: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        tenant_id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        disabled_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS linkedin_tokens (
        tenant_id TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        scopes TEXT NOT NULL,
        member_sub TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS publish_operations (
        tenant_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        post_urn TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        PRIMARY KEY (tenant_id, content_hash)
      )`,
      `CREATE TABLE IF NOT EXISTS publish_budgets (
        tenant_id TEXT PRIMARY KEY,
        window_ms BIGINT NOT NULL,
        capacity INTEGER NOT NULL,
        hits TEXT NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        label TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_tenant ON linkedin_tokens(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_states_tenant ON oauth_states(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ops_tenant ON publish_operations(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_api_tokens_tenant ON api_tokens(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_log(tenant_id, created_at DESC)`,
    ],
    sqlite: [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        tenant_id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        disabled_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS linkedin_tokens (
        tenant_id TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        scopes TEXT NOT NULL,
        member_sub TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS publish_operations (
        tenant_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        post_urn TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        PRIMARY KEY (tenant_id, content_hash)
      )`,
      `CREATE TABLE IF NOT EXISTS publish_budgets (
        tenant_id TEXT PRIMARY KEY,
        window_ms BIGINT NOT NULL,
        capacity INTEGER NOT NULL,
        hits TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_tenant ON linkedin_tokens(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_states_tenant ON oauth_states(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ops_tenant ON publish_operations(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_api_tokens ON api_tokens(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_log(tenant_id, created_at DESC)`,
    ],
  },
  {
    // M9 (issues #13/#14): billing tables. webhook_events.event_id is the
    // replay/duplicate boundary (unique constraint); entitlements +
    // usage_counters are tenant-scoped like every other tenant-owned table.
    id: 2,
    name: 'billing tables',
    postgres: [
      `CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS subscriptions (
        tenant_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        provider_status TEXT NOT NULL,
        entitlement_status TEXT NOT NULL,
        grace_ends_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS entitlements (
        tenant_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        grace_ends_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS usage_counters (
        tenant_id TEXT NOT NULL,
        counter TEXT NOT NULL,
        window_ms BIGINT NOT NULL,
        hits TEXT NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, counter)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant ON webhook_events(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_usage_counters_tenant ON usage_counters(tenant_id)`,
    ],
    sqlite: [
      `CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS subscriptions (
        tenant_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        provider_status TEXT NOT NULL,
        entitlement_status TEXT NOT NULL,
        grace_ends_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS entitlements (
        tenant_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        grace_ends_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS usage_counters (
        tenant_id TEXT NOT NULL,
        counter TEXT NOT NULL,
        window_ms BIGINT NOT NULL,
        hits TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, counter)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant ON webhook_events(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_usage_counters_tenant ON usage_counters(tenant_id)`,
    ],
  },
];

/** Apply all pending migrations idempotently. */
export async function applyMigrations(exec: SqlExecutor): Promise<string[]> {
  // Bootstrap: the tracking table itself is created unconditionally (IF
  // NOT EXISTS), in the executor's dialect, so a fresh database can be
  // introspected before any migration exists.
  const bootstrap =
    exec.kind === 'postgres'
      ? `CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`
      : `CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`;
  await exec.execute({ sql: bootstrap });
  const applied = new Set<number>();
  const rows = await exec.query({ sql: 'SELECT id FROM schema_migrations' });
  for (const row of rows) {
    applied.add(Number(row.id));
  }
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const stmts = (exec.kind === 'postgres' ? m.postgres : m.sqlite).map((sql) => ({ sql }));
    await exec.with(async (tx) => {
      for (const st of stmts) {
        await tx.execute(st);
      }
      await tx.execute({
        sql: 'INSERT INTO schema_migrations (id, name) VALUES ($1, $2)',
        params: [m.id, m.name],
      });
    });
    ran.push(`m${String(m.id)}:${m.name}`);
  }
  if (ran.length > 0) {
    log.info('migrations applied', { count: ran.length, backend: exec.kind });
  }
  return ran;
}
