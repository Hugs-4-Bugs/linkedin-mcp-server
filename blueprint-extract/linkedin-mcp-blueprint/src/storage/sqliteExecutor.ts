/**
 * SQLite executor (M5, ADR-018): local development + deterministic
 * database integration tests. Uses Node's built-in `node:sqlite`
 * (DatabaseSync) — zero new dependencies, one file per environment.
 *
 * The same schema and SQL as Postgres (placeholders are translated from
 * `$1..n` to `?`). Transactions serialize on a single connection with an
 * async mutex (SQLite single-writer model), matching the executor contract.
 */
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../observability/logger.js';
import type { SqlExecutor, SqlResult, SqlStatement } from './sqlExecutor.js';

const log = createLogger('storage:sqlite');

/** Convert $1/$2/... placeholders to SQLite `?`. */
function toSqlite(sql: string): string {
  // $N -> ?N (numbered). Numbered placeholders bind by NAME, not position,
  // so statements whose placeholder order differs from param-array order
  // (e.g. SET x = $2 WHERE y = $1) stay correct in both dialects.
  return sql.replace(/\$(\d+)/g, '?$1');
}

export class SqliteExecutor implements SqlExecutor {
  readonly kind = 'sqlite' as const;
  private readonly db: DatabaseSync;
  private txLock: Promise<unknown> = Promise.resolve();

  constructor(filePath: ':memory:' | (string & {})) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  private translate(st: SqlStatement): { sql: string; params: unknown[] } {
    return { sql: toSqlite(st.sql), params: st.params ? [...st.params] : [] };
  }

  query(st: SqlStatement): Promise<SqlResult> {
    const { sql, params } = this.translate(st);
    const rows = this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    return Promise.resolve(rows as unknown as SqlResult);
  }

  execute(st: SqlStatement): Promise<number> {
    const { sql, params } = this.translate(st);
    const info = this.db.prepare(sql).run(...(params as never[]));
    return Promise.resolve(Number(info.changes));
  }

  async with<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    // Serialize transactions on this connection (single-writer).
    const prev = this.txLock;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.txLock = gate;
    await prev;
    this.db.exec('BEGIN');
    try {
      const out = await body(this);
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackErr) {
        log.error('rollback failed', { message: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr) });
      }
      throw err;
    } finally {
      release?.();
    }
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
