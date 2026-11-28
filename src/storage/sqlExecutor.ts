/**
 * SQL executor seam (M5, ADR-018): the only place that knows how to talk to
 * a database. Two implementations:
 *  - PostgresExecutor: production/staging persistence via `pg` (pinned dep
 *    since M1, already used for this exact purpose in the blueprint).
 *  - SqliteExecutor:   local development / deterministic integration tests
 *    via `node:sqlite` (Node's built-in, no new dependency).
 *
 * Everything else in the storage layer speaks parameterized SQL through
 * this interface — no ORM, no raw string concatenation of values, no
 * provider-specific code outside this directory. Transactions are explicit
 * (with() = BEGIN/COMMIT/ROLLBACK) and serialize per-connection.
 *
 * The in-memory dev/test mode keeps the existing M2–M4 behavior exactly
 * (PostgresExecutor only activates when DATABASE_URL is set).
 */

export type SqlRow = Readonly<Record<string, unknown>>;

/** One parameterized statement with values. No identifier interpolation. */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

/** READ RESULT SHAPE — arrays of rows, fully materialized. */
export type SqlResult = readonly SqlRow[];

export interface SqlExecutor {
  /** SELECT — returns rows. */
  query(statements: SqlStatement): Promise<SqlResult>;
  /** INSERT/UPDATE/DELETE — returns affected row count. */
  execute(statements: SqlStatement): Promise<number>;
  /**
   * Run statements inside one transaction: BEGIN, body, COMMIT; ROLLBACK on
   * any throw. The body sees the same executor so statements participate
   * in the transaction. Concurrency: implementations serialize transactions
   * (one at a time per executor) — callers must NOT rely on parallel tx.
   */
  with<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Close connections; idempotent. */
  close(): Promise<void>;
  /** Backend name for logs/health (never logs credentials). */
  readonly kind: 'postgres' | 'sqlite';
}

/** Translate unknown to a nullable primitive storable in a TEXT column. */
export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Translate unknown to a nullable integer. */
export function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}
