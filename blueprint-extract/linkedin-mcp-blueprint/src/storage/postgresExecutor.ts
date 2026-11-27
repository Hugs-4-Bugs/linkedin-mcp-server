/**
 * Postgres executor (M5, ADR-018): persistence for staging/production.
 * Uses `pg` (pinned 8.16.0). One pooled client per process; transactions
 * serialize on a checkout (pg pool checkout IS the serialization point —
 * with() checks out a dedicated client so concurrent with() calls get
 * different clients from the pool, each internally serialized).
 *
 * Security: parameterized statements only ($1, $2, ...); the DATABASE_URL
 * never appears in logs (the executor logs only `kind`).
 */
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { createLogger } from '../observability/logger.js';
import type { SqlExecutor, SqlResult, SqlStatement } from './sqlExecutor.js';

const log = createLogger('storage:pg');

export interface PostgresExecutorOptions {
  /** postgres:// connection string from env (never logged). */
  url: string;
  /** Max pool size (default 8). */
  max?: number;
  /** Startup statement timeout applied per query (ms, default 10000). */
  statementTimeoutMs?: number;
}

function toPg(st: SqlStatement): { text: string; values: unknown[] } {
  return { text: st.sql, values: st.params ? [...st.params] : [] };
}

export class PostgresExecutor implements SqlExecutor {
  readonly kind = 'postgres' as const;
  private readonly pool: Pool;
  private readonly statementTimeoutMs: number;

  constructor(opts: PostgresExecutorOptions) {
    this.pool = new Pool({
      connectionString: opts.url,
      max: opts.max ?? 8,
      // Fail fast rather than hang when the DB is unreachable.
      connectionTimeoutMillis: 10_000,
    });
    this.statementTimeoutMs = opts.statementTimeoutMs ?? 10_000;
    // Per-statement timeout so a wedged query cannot hold a checkout forever.
    this.pool.on('error', (err) => {
      log.error('pg pool error', { message: err.message });
    });
  }

  async query(st: SqlStatement): Promise<SqlResult> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET LOCAL statement_timeout = ${String(this.statementTimeoutMs)}`);
      const res = await client.query<Record<string, unknown>>(toPg(st));
      // pg types rows as any[]; the executor contract owns the row shape.
      return res.rows;
    } finally {
      client.release();
    }
  }

  async execute(st: SqlStatement): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query(`SET LOCAL statement_timeout = ${String(this.statementTimeoutMs)}`);
      const res = await client.query<Record<string, unknown>>(toPg(st));
      return res.rowCount ?? 0;
    } finally {
      client.release();
    }
  }

  async with<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const tx = new PgTransaction(client, this.statementTimeoutMs);
    try {
      await client.query('BEGIN');
      const out = await body(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        log.error('rollback failed', { message: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr) });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Executor view bound to one checked-out client (inside with()). */
class PgTransaction implements SqlExecutor {
  readonly kind = 'postgres' as const;

  constructor(
    private readonly client: PoolClient,
    private readonly statementTimeoutMs: number,
  ) {}

  private async run<T extends Record<string, unknown>>(st: SqlStatement): Promise<QueryResult<T>> {
    await this.client.query(`SET LOCAL statement_timeout = ${String(this.statementTimeoutMs)}`);
    return this.client.query<T>(toPg(st));
  }

  async query(st: SqlStatement): Promise<SqlResult> {
    const res = await this.run<Record<string, unknown>>(st);
    return res.rows;
  }

  async execute(st: SqlStatement): Promise<number> {
    const res = await this.run<Record<string, unknown>>(st);
    return res.rowCount ?? 0;
  }

  async with<T>(body: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    // Savepoint for nested with() — keeps the outer transaction atomic.
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
    await this.client.query(`SAVEPOINT ${sp}`);
    try {
      const out = await body(this);
      await this.client.query(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    // Closing inside a transaction would break the outer flow; no-op.
  }
}
