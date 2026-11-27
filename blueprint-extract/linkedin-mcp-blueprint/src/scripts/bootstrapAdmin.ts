/**
 * First-run admin bootstrap (M5): creates the initial console user so an
 * operator can sign in to /admin and drive the OAuth + publishing flows.
 * Run against the SAME DATABASE_URL the server uses:
 *
 *   node dist/scripts/bootstrapAdmin.js <username> <password>
 *
 *   docker compose exec app node dist/scripts/bootstrapAdmin.js admin '…'
 *
 * Refuses weak passwords (< 10 chars). Password hashes are scrypt with a
 * per-user salt (same store the login route verifies against).
 */
import { loadConfig } from '../config/config.js';
import { buildPersistentRuntime } from '../mcp/serverFactory.js';

async function main(): Promise<void> {
  const [username, password] = process.argv.slice(2) as [string | undefined, string | undefined];
  if (username === undefined || password === undefined) {
    console.error('usage: bootstrapAdmin.js <username> <password>');
    process.exit(2);
  }
  if (password.length < 10) {
    console.error('password must be at least 10 characters');
    process.exit(2);
  }
  const config = loadConfig();
  if (config.DATABASE_URL === undefined) {
    console.error('DATABASE_URL is required (persistent storage mode)');
    process.exit(2);
  }
  const runtime = await buildPersistentRuntime(config);
  if (runtime.authStore === undefined) {
    console.error('auth store unavailable (no persistence)');
    await runtime.close();
    process.exit(2);
  }
  try {
    const user = await runtime.authStore.createUser(username, password, 'admin');
    console.log(`user created: ${user.username} (tenant ${user.tenantId})`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await runtime.close();
  }
}

void main();
