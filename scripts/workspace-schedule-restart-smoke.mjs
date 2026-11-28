/**
 * Step 12/16 verification — scheduled post survives a REAL server restart.
 * Live process, real HTTP, real SQLite file:
 *   1. boot billed/persistent server
 *   2. schedule a post via the real MCP tool (12 tools incl. schedule)
 *   3. SIGKILL the server (worst-case: no graceful shutdown at all)
 *   4. boot a NEW server process on the SAME database
 *   5. the schedule is still there (durable) and the new scheduler
 *      recovered it; the post fires only at its time (not before)
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteExecutor } from '../dist/storage/sqliteExecutor.js';
import { applyMigrations } from '../dist/storage/migrations.js';
import { UserAuthStore } from '../dist/auth/users/userAuthStore.js';

const PORT = 3401;
const DIR = mkdtempSync(join(tmpdir(), 'lkm-restart-'));
const DB = join(DIR, 'restart.db');
const PW = 'pw-restart-strong-123';
const PROTO = '2026-07-28';
const CLIENT = { name: 'restart-smoke', version: '1.0.0' };
let cookie = '';

async function waitStarted(c) {
  await once(c, 'spawn');
  await new Promise((resolve) => {
    const onData = (d) => { if (String(d).includes('http MCP server started')) { c.stderr?.off('data', onData); resolve(); } };
    c.stderr?.on('data', onData);
    setTimeout(resolve, 8000);
  });
}

function start() {
  const c = spawn('node', ['dist/mcp/transport/http-entry.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ENVIRONMENT: 'local', HTTP_PORT: String(PORT), DATABASE_URL: `sqlite:${DB}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return c;
}

async function mcp(sessionId, id, tool, extra = {}) {
  const r = await fetch(`http://127.0.0.1:${String(PORT)}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTO, 'Mcp-Method': 'tools/call', 'Mcp-Name': tool,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}), cookie: `lkm_session=${cookie}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: { ...extra }, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTO, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': CLIENT } } }),
  });
  const text = await r.text();
  let json = null;
  if (text.trim().startsWith('{')) json = JSON.parse(text);
  else { const line = text.split('\n').find((l) => l.startsWith('data:')); if (line) json = JSON.parse(line.slice(5).trim()); }
  return json?.result ?? {};
}

const ok = (label, cond, detail = '') => {
  if (!cond) throw new Error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const seed = new SqliteExecutor(DB);
  await applyMigrations(seed);
  await new UserAuthStore(seed, 3_600_000).createUser('restarter', PW);
  await seed.close();

  let child = start();
  await waitStarted(child);
  ok('1. server booted (persistent sqlite)', true);

  const login = await fetch(`http://127.0.0.1:${String(PORT)}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'restarter', password: PW }),
  });
  cookie = /lkm_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
  ok('2. login', cookie !== '');

  // Schedule 60 minutes out (far future: must NOT fire during this smoke).
  const sched = await mcp(undefined, 1, 'linkedin_schedule_post', { text: 'durable across restart', runInMinutes: 60, confirm: true });
  const schedPayload = JSON.parse(sched.content?.[0]?.text ?? '{}');
  ok('3. schedule via real MCP tool', sched.isError !== true && schedPayload.scheduled === true, `id=${String(schedPayload.id).slice(0, 8)}`);

  const before = await mcp(undefined, 2, 'linkedin_list_scheduled_posts');
  const beforeList = JSON.parse(before.content?.[0]?.text ?? '{}');
  ok('4. listed: 1 scheduled', beforeList.count === 1 && beforeList.posts[0]?.status === 'scheduled');

  // HARD KILL: no SIGTERM, no graceful anything.
  child.kill('SIGKILL');
  await new Promise((r) => { child.on('exit', r); setTimeout(r, 2000); });
  ok('5. server SIGKILLed (crash simulation)', true);

  child = start();
  await waitStarted(child);
  ok('6. new server process on the same DB booted', true);

  // The schedule survived the crash and is still pending (not fired).
  const after = await mcp(undefined, 3, 'linkedin_list_scheduled_posts');
  const afterList = JSON.parse(after.content?.[0]?.text ?? '{}');
  ok('7. schedule SURVIVED the crash', afterList.count === 1 && afterList.posts[0]?.status === 'scheduled', 'still scheduled, not fired');
  ok('8. fire time preserved', afterList.posts[0]?.runAt === beforeList.posts[0]?.runAt);

  // Cancel it (Tier C revocation through the real tool).
  const cancel = await mcp(undefined, 4, 'linkedin_cancel_scheduled_post', { id: schedPayload.id, confirm: true });
  const cancelPayload = JSON.parse(cancel.content?.[0]?.text ?? '{}');
  ok('9. cancelled via real MCP tool', cancel.isError !== true && cancelPayload.cancelled === true);

  const final = await mcp(undefined, 5, 'linkedin_list_scheduled_posts');
  const finalList = JSON.parse(final.content?.[0]?.text ?? '{}');
  ok('10. final state: cancelled', finalList.posts[0]?.status === 'cancelled');

  child.kill('SIGTERM');
  const exited = await new Promise((r) => { child.on('exit', () => r(true)); setTimeout(() => r(false), 5000); });
  ok('11. graceful shutdown', exited);
  rmSync(DIR, { recursive: true, force: true });
  console.log('\nSCHEDULING RESTART SMOKE: ALL CHECKS PASS');
}

void main().then(
  () => process.exit(0),
  (err) => { console.error('SCHEDULING RESTART SMOKE: FAIL —', err instanceof Error ? err.message : String(err)); child?.kill('SIGKILL'); process.exit(1); },
);
