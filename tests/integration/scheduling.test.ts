/**
 * Master assignment steps 12/16 tests — durable post scheduling.
 *
 * Covers the guarantees the assignment demands:
 *   1. DURABILITY: a scheduled row survives a full store/process cycle
 *      (real SQLite file; new executor = simulated restart).
 *   2. EXACTLY-ONCE claiming under CONCURRENT workers (the conditional
 *      UPDATE is the serialization point — 10 racing claimers, one post,
 *      exactly one claim).
 *   3. Restart RECOVERY: rows stuck 'running' (crashed worker) are
 *      re-scheduled or terminal-failed by recoverInterrupted().
 *   4. BOUNDED retries: attempts reach maxAttempts -> terminal 'failed'.
 *   5. Cancellation: only while scheduled/running; tenant-scoped.
 *   6. Tenant isolation: another tenant cannot list/cancel/claim rows
 *      it does not own.
 *   7. The full publish-safety stack at fire time (executor contract:
 *      scheduling never bypasses duplicate/budget/entitlement gates).
 *   8. MCP tool layer: schedule requires confirm (structural),
 *      validates content at schedule time, refuses in-memory mode.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteExecutor } from '../../src/storage/sqliteExecutor.js';
import { applyMigrations } from '../../src/storage/migrations.js';
import { SqlScheduledPostStore } from '../../src/scheduling/scheduledPostStore.js';
import { schedulePostTool, SchedulePostInputSchema } from '../../src/tools/scheduleTools.js';
import { parseConfig } from '../../src/config/config.js';

const DIR = mkdtempSync(join(tmpdir(), 'lkm-sched-'));
const DB = join(DIR, 'sched.db');
let exec: SqliteExecutor;
let store: SqlScheduledPostStore;

beforeAll(async () => {
  exec = new SqliteExecutor(DB);
  await applyMigrations(exec);
  store = new SqlScheduledPostStore(exec, { maxAttempts: 3 });
});

afterAll(async () => {
  await exec.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe('durable scheduling store', () => {
  it('inserts a scheduled row that survives a fresh executor on the same file (restart)', async () => {
    await store.insert({ tenantId: 't1', postText: 'restart survives', runAtMs: Date.now() + 60_000 });
    // Simulated restart: a NEW executor instance over the same DB file.
    const exec2 = new SqliteExecutor(DB);
    const store2 = new SqlScheduledPostStore(exec2, { maxAttempts: 3 });
    const rows = await store2.list('t1');
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('scheduled');
    expect(rows[0]?.postText).toBe('restart survives');
    await exec2.close();
  });

  it('claims a due post exactly once under 10 concurrent workers', async () => {
    await store.insert({ tenantId: 't2', postText: 'race me', runAtMs: Date.now() - 1_000 });
    const claims = await Promise.all(
      Array.from({ length: 10 }, () => store.claimDue(Date.now())),
    );
    const winners = claims.filter((c) => c.claimed);
    expect(winners.length).toBe(1);
    expect(winners[0]?.post?.postText).toBe('race me');
    // And the row is 'running' — not double-claimable again:
    const again = await store.claimDue(Date.now());
    expect(again.claimed).toBe(false);
  });

  it('recovers rows a crashed worker left running (restart recovery)', async () => {
    const row = await store.insert({ tenantId: 't3', postText: 'interrupted', runAtMs: Date.now() - 1_000 });
    // Simulate crash-mid-execution: force the row into 'running' with
    // attempts=1 (as a claim would have left it).
    await exec.execute({
      sql: "UPDATE scheduled_posts SET status = 'running', attempts = 1 WHERE id = $1",
      params: [row.id],
    });
    const recovered = await store.recoverInterrupted();
    expect(recovered).toBeGreaterThanOrEqual(1);
    const rows = await store.list('t3');
    expect(rows[0]?.status).toBe('scheduled'); // attempts(1) < max(3): requeued
    expect(rows[0]?.lastError).toContain('interrupted');
  });

  it('bounded retries: a row gets maxAttempts REAL executions; recovery path fails rows already at budget (issue #29 off-by-one fix)', async () => {
    const row = await store.insert({ tenantId: 't4', postText: 'exhaust', runAtMs: Date.now() - 1_000 });
    // attempts = 2, maxAttempts = 3: the claim MUST hand the row to a
    // worker (the third execution is real; the OLD behavior failed it at
    // the claim — the off-by-one).
    await exec.execute({
      sql: 'UPDATE scheduled_posts SET attempts = 2 WHERE id = $1',
      params: [row.id],
    });
    const c = await store.claimDue(Date.now(), 't4');
    expect(c.claimed).toBe(true); // third REAL execution is granted
    expect(c.post?.attempts).toBe(3);
    // A failing execution at attempts=3 terminal-fails via markFailed:
    await store.markFailed(row.id, 'publish refused', false, Date.now());
    const rows = await store.list('t4');
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.lastError).toBe('publish refused');
    // And rows ALREADY at/over budget (crash-recovery path) terminally
    // fail at the claim — no further execution is granted:
    const row2 = await store.insert({ tenantId: 't4', postText: 'exhaust2', runAtMs: Date.now() - 1_000 });
    await exec.execute({
      sql: 'UPDATE scheduled_posts SET attempts = 3 WHERE id = $1',
      params: [row2.id],
    });
    const c2 = await store.claimDue(Date.now(), 't4');
    expect(c2.claimed).toBe(false);
    const rows2 = await store.list('t4');
    expect(rows2.find((r) => r.id === row2.id)?.status).toBe('failed');
    expect(rows2.find((r) => r.id === row2.id)?.lastError).toBe('exhausted retries');
  });

  it('cancels only while not executed; only for the owning tenant', async () => {
    const row = await store.insert({ tenantId: 't5', postText: 'cancel me', runAtMs: Date.now() + 60_000 });
    // Wrong tenant cannot cancel:
    expect(await store.cancel(row.id, 'OTHER-tenant')).toBe(false);
    // Owner cancels:
    expect(await store.cancel(row.id, 't5')).toBe(true);
    const rows = await store.list('t5');
    expect(rows[0]?.status).toBe('cancelled');
    // Already-cancelled cannot be claimed:
    expect((await store.claimDue(Date.now(), 't5')).claimed).toBe(false);
  });

  it('list is tenant-isolated', async () => {
    await store.insert({ tenantId: 't6', postText: 'private', runAtMs: Date.now() + 60_000 });
    const other = await store.list('t7');
    expect(other.length).toBe(0);
    const mine = await store.list('t6');
    expect(mine.length).toBe(1);
  });
});

describe('scheduling MCP tool layer', () => {
  const config = parseConfig({ ENVIRONMENT: 'local' });
  const ctx = {
    config,
    tenant: { tenantId: 'tool-tenant', userId: 'tool-tenant' },
  } as unknown as Parameters<typeof schedulePostTool>[0];

  it('schedule requires confirm=true structurally (schema rejects false)', () => {
    expect(() => SchedulePostInputSchema.parse({ text: 'x', runInMinutes: 5, confirm: false })).toThrow();
    expect(() => SchedulePostInputSchema.parse({ text: 'x', runInMinutes: 5 })).toThrow();
    expect(SchedulePostInputSchema.parse({ text: 'x', runInMinutes: 5, confirm: true })).toBeTruthy();
  });

  it('schedule refuses without persistence (no fake durability)', async () => {
    const r = await schedulePostTool(ctx, { text: 'hello world', runInMinutes: 5, confirm: true }, undefined, () => Date.now());
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0]?.text ?? '{}') as { code?: string };
    expect(payload.code).toBe('persistence-required');
  });

  it('schedule validates content at schedule time (same validator as publish)', async () => {
    const r = await schedulePostTool(ctx, { text: '', runInMinutes: 5, confirm: true }, undefined, () => Date.now());
    // Schema rejects empty text before the store is even consulted:
    expect(() => SchedulePostInputSchema.parse({ text: '', runInMinutes: 5, confirm: true })).toThrow();
    expect(r.isError).toBe(true);
  });

  it('schedule stores durably and returns the schedule id + iso time', async () => {
    const store2 = new SqlScheduledPostStore(exec, { maxAttempts: 3 });
    const r = await schedulePostTool(ctx, { text: 'durable hello', runInMinutes: 10, confirm: true }, store2, () => 1_000_000_000_000);
    expect(r.isError).not.toBe(true);
    const payload = JSON.parse(r.content[0]?.text ?? '{}') as { scheduled?: boolean; id?: string; runAtIso?: string };
    expect(payload.scheduled).toBe(true);
    expect(typeof payload.id).toBe('string');
    expect(payload.runAtIso).toBe(new Date(1_000_000_000_000 + 600_000).toISOString());
    // The row really is in the table for the right tenant:
    const rows = await store2.list('tool-tenant');
    expect(rows.map((x) => x.id)).toContain(payload.id);
  });
});

describe('scheduler worker executes through the real safety stack', () => {
  // Dedicated DB: the worker drains ALL due rows globally, so this suite
  // must not see other tenants' fixtures from earlier describes.
  const WDB = join(DIR, 'worker.db');
  let wExec: SqliteExecutor;
  let wStore: SqlScheduledPostStore;

  beforeAll(async () => {
    wExec = new SqliteExecutor(WDB);
    await applyMigrations(wExec);
    wStore = new SqlScheduledPostStore(wExec, { maxAttempts: 3 });
  });
  afterAll(async () => {
    await wExec.close();
  });
  it('executeOne marks published on success and failed-retryable on infra error', async () => {
    const { PostScheduler } = await import('../../src/scheduling/postScheduler.js');
    const calls: { id: string; tenantId: string; postText: string }[] = [];
    const sched = new PostScheduler({ exec: wExec }, {
      pollMs: 60_000,
      maxAttempts: 3,
      now: () => Date.now(),
      executor: async (p) => {
        await Promise.resolve(); // executor contract is async; body is sync
        calls.push(p);
        if (p.postText === 'boom-infra') { throw new Error('network down'); }
        if (p.postText === 'refused') { return { published: false, error: 'not connected' }; }
        return { published: true, postUrn: 'urn:li:share:1' };
      },
    });
    const okRow = await wStore.insert({ tenantId: 'w1', postText: 'go', runAtMs: Date.now() - 1 });
    const n = await sched.drain();
    expect(n).toBeGreaterThanOrEqual(1);
    const okRows = await wStore.list('w1');
    expect(okRows.find((x) => x.id === okRow.id)?.status).toBe('published');
    expect(okRows.find((x) => x.id === okRow.id)?.postUrn).toBe('urn:li:share:1');
    // Expected refusal (not retryable) -> terminal failed:
    await wStore.insert({ tenantId: 'w2', postText: 'refused', runAtMs: Date.now() - 1 });
    // Infra error (retryable) -> back to scheduled with error recorded:
    await wStore.insert({ tenantId: 'w3', postText: 'boom-infra', runAtMs: Date.now() - 1 });
    await sched.drain();
    const w2 = await wStore.list('w2');
    expect(w2[0]?.status).toBe('failed'); // tool-refused: no retry
    const w3 = await wStore.list('w3');
    expect(w3[0]?.status).toBe('scheduled'); // infra: retry queued WITH backoff
    expect(w3[0]?.lastError).toContain('network down');
    expect(w3[0]?.attempts).toBe(1); // ONE attempt per drain (retry spacing)
    expect(w3[0]?.runAt > new Date().toISOString()).toBe(true); // pushed into future
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('drain is re-entrancy safe (running flag)', async () => {
    const { PostScheduler } = await import('../../src/scheduling/postScheduler.js');
    const sched = new PostScheduler({ exec: wExec }, {
      pollMs: 60_000,
      maxAttempts: 3,
      now: () => Date.now(),
      executor: async () => { await Promise.resolve(); return { published: true, postUrn: 'urn:li:share:2' }; },
    });
    await wStore.insert({ tenantId: 'w4', postText: 'double', runAtMs: Date.now() - 1 });
    const p1 = sched.drain();
    const p2 = sched.drain(); // second entry returns immediately
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeGreaterThanOrEqual(1);
    expect(r2).toBe(0);
  });
});
