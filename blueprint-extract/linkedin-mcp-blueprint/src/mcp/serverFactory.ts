/**
 * Server factory: builds the McpServer instance with the tool catalog
 * attached. One factory for both transports (ADR-006): no transport-specific
 * behavior may leak into tool implementations.
 *
 * M2: the factory takes an AppRuntime (config + connection service + vault +
 * budgets + tenant) and registers the connection lifecycle tools alongside
 * the server status tool. Tool registration now ENFORCES policy metadata:
 * every tool is registered through registerToolWithPolicy, which routes the
 * call through authorize() with the tenant's live connection status.
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../config/config.js';
import { createLogger } from '../observability/logger.js';
import { LOCAL_DEV_TENANT, type TenantContext } from '../identity/tenant.js';
import { BucketRegistry } from '../usage/tokenBucket.js';
import { LinkedInConnectionService } from '../auth/linkedin/connectionService.js';
import { InMemoryTokenVault, generateVaultKey } from '../auth/linkedin/tokenVault.js';
import { LinkedInMockProvider } from '../auth/linkedin/mockProvider.js';
import { LinkedInRealProvider } from '../auth/linkedin/realProvider.js';
import type { LinkedInOAuthProvider } from '../auth/linkedin/provider.js';
import { PostOperationStore } from '../auth/linkedin/postOperationStore.js';
import { PeriodicSweeper, type RetentionPolicy } from '../storage/retention.js';
import { SqlPostOperationStore, SqlPublishBudget } from '../auth/linkedin/sqlPublishStores.js';
import { SqlTokenVault } from '../auth/linkedin/sqlTokenVault.js';
import { SqlOAuthStateStore } from '../auth/linkedin/sqlStateStore.js';
import { UserAuthStore } from '../auth/users/userAuthStore.js';
import { currentTenant } from '../identity/requestTenant.js';
import { SqlExecutor } from '../storage/sqlExecutor.js';
import { PostgresExecutor } from '../storage/postgresExecutor.js';
import { SqliteExecutor } from '../storage/sqliteExecutor.js';
import { applyMigrations } from '../storage/migrations.js';
import type { ToolContext } from '../tools/toolContext.js';
import {
  CONNECTION_TOOL_SPECS,
  connectTool,
  disconnectTool,
  statusTool,
} from '../tools/connectionTools.js';
import {
  PROFILE_TOOL_SPEC,
  SCOPE_TOOL_SPEC,
  getMyProfileTool,
  listGrantedScopesTool,
} from '../tools/profileTools.js';
import {
  DRAFT_TOOL_SPEC,
  PREVIEW_TOOL_SPEC,
  PUBLISH_TOOL_SPEC,
  DraftPostInputSchema,
  PreviewPostInputSchema,
  PublishPostInputSchema,
  draftPostTool,
  previewPostTool,
  publishPostTool,
} from '../tools/publishTools.js';

const log = createLogger('mcp:server');

/** M1 catalog keeps its own status tool. */
const SERVER_STATUS_SCHEMA = z.object({}).strict();

export interface ServerStatus {
  server: string;
  version: string;
  environment: string;
  oauthProvider: 'mock' | 'linkedin';
  linkedin: 'not-connected' | 'connected';
}

/** Everything a tool needs at call time; assembled once per server build. */
export interface AppRuntime {
  config: AppConfig;
  tenant: TenantContext;
  connection: LinkedInConnectionService;
  vault: import('../auth/linkedin/tokenVault.js').TokenVault;
  callBudgets: BucketRegistry;
  /** OAuth provider in use (mock or real); tools receive it via ToolContext. */
  provider: LinkedInOAuthProvider;
  /** Present only when OAUTH_PROVIDER=mock (route-level mock consent flow). */
  mockProvider: LinkedInMockProvider | undefined;
  /** Publication operation ledger (M4, ADR-016; SQL or in-memory). */
  postOps: PostOperationStore | SqlPostOperationStore;
  /** Per-tenant daily publish budget (application safety limit, ADR-015). */
  publishBudgets: BucketRegistry;
  /** M5: 'postgres' | 'sqlite' | 'in-memory'. */
  storageBackend: string;
  /** M5: user/session store (SQL persistence mode only). */
  authStore: import('../auth/users/userAuthStore.js').UserAuthStore | undefined;
  /** M5: SQL publish budget when persistence is active. */
  publishBudgetSql: SqlPublishBudget | undefined;
  /** Close persistent resources (DB pool). No-op in in-memory mode. */
  close(): Promise<void>;
}

/**
 * Build the runtime for a config. Local/dev runs use the mock provider
 * (owner M2 directive) unless real credentials are configured; the real
 * provider requires the full credential triple (config-enforced).
 */
export function buildRuntime(config: AppConfig): AppRuntime {
  const provider =
    config.OAUTH_PROVIDER === 'linkedin'
      ? new LinkedInRealProvider()
      : new LinkedInMockProvider();
  const vaultKey = config.TOKEN_VAULT_KEY ?? generateVaultKey();
  if (config.TOKEN_VAULT_KEY === undefined) {
    log.warn('TOKEN_VAULT_KEY unset; using an ephemeral key (tokens lost on restart; local dev only)');
  }
  const vault = new InMemoryTokenVault(vaultKey);
  const connection = new LinkedInConnectionService(config, provider, vault);
  return {
    config,
    tenant: LOCAL_DEV_TENANT,
    connection,
    vault,
    callBudgets: new BucketRegistry({ capacity: 60, windowMs: 86_400_000 }), // LinkedIn share ceiling shape
    provider,
    mockProvider: config.OAUTH_PROVIDER === 'mock' ? (provider as LinkedInMockProvider) : undefined,
    postOps: new PostOperationStore({
      duplicateWindowMs: config.PUBLISH_DUPLICATE_WINDOW_MINUTES * 60_000,
    }),
    publishBudgets: new BucketRegistry({ capacity: config.PUBLISH_DAILY_LIMIT, windowMs: 86_400_000 }),
    storageBackend: 'in-memory',
    authStore: undefined,
    publishBudgetSql: undefined,
    async close(): Promise<void> {
      /* in-memory runtime: nothing to close */
    },
  } satisfies AppRuntime;
}

/**
 * Build the runtime WITH persistent storage (M5, ADR-018). Activated when
 * DATABASE_URL is set:
 *   - postgres://…  → PostgresExecutor (staging/production)
 *   - sqlite:PATH   → SqliteExecutor (local persistence + integration tests)
 * Migrations run at startup (idempotent). Tokens keep the SAME
 * AES-256-GCM envelope — the DB stores ciphertext only. When DATABASE_URL
 * is unset this is identical to buildRuntime (M2–M4 behavior).
 */
export async function buildPersistentRuntime(config: AppConfig): Promise<AppRuntime> {
  if (config.DATABASE_URL === undefined) {
    return buildRuntime(config);
  }
  const url = config.DATABASE_URL;
  const exec: SqlExecutor = url.startsWith('sqlite:')
    ? new SqliteExecutor(url.slice('sqlite:'.length) || ':memory:')
    : new PostgresExecutor({ url });
  await applyMigrations(exec);

  const provider =
    config.OAUTH_PROVIDER === 'linkedin'
      ? new LinkedInRealProvider()
      : new LinkedInMockProvider();
  const vaultKey = config.TOKEN_VAULT_KEY ?? generateVaultKey();
  if (config.TOKEN_VAULT_KEY === undefined) {
    log.warn('TOKEN_VAULT_KEY unset; using an ephemeral key (tokens lost on restart; local dev only)');
  }
  const vault = new SqlTokenVault(exec, vaultKey);
  const stateStore = new SqlOAuthStateStore(exec, config.OAUTH_STATE_TTL_SECONDS * 1000);
  const connection = new LinkedInConnectionService(config, provider, vault, () => Date.now(), stateStore);
  const postOps = new SqlPostOperationStore(
    exec,
    config.PUBLISH_DUPLICATE_WINDOW_MINUTES * 60_000,
  );
  const authStore = new UserAuthStore(exec, config.SESSION_TTL_SECONDS * 1000);
  const publishBudgetSql = new SqlPublishBudget(
    exec,
    config.PUBLISH_DAILY_LIMIT,
    86_400_000,
  );
  // Retention sweeper (M7 issue #16, ADR-010): periodic per-class TTL
  // deletion. Interval from config; 0 = boot sweep only.
  const sweeper = config.RETENTION_SWEEP_INTERVAL_SECONDS > 0
    ? PeriodicSweeper.start(exec, config.RETENTION_SWEEP_INTERVAL_SECONDS * 1000, {
        sessionTtlMs: config.SESSION_TTL_SECONDS * 1000,
        oauthStateTtlMs: config.OAUTH_STATE_TTL_SECONDS * 1000,
        publishOpHorizonMs: config.PUBLISH_DUPLICATE_WINDOW_MINUTES * 60_000,
        auditRetentionMs: config.AUDIT_RETENTION_DAYS * 86_400_000,
        budgetWindowMs: 86_400_000,
      } satisfies Partial<RetentionPolicy>)
    : undefined;
  return {
    config,
    tenant: LOCAL_DEV_TENANT,
    connection,
    vault,
    callBudgets: new BucketRegistry({ capacity: 60, windowMs: 86_400_000 }),
    provider,
    mockProvider: config.OAUTH_PROVIDER === 'mock' ? (provider as LinkedInMockProvider) : undefined,
    postOps,
    publishBudgets: new BucketRegistry({ capacity: config.PUBLISH_DAILY_LIMIT, windowMs: 86_400_000 }),
    storageBackend: exec.kind,
    authStore,
    publishBudgetSql,
    async close(): Promise<void> {
      sweeper?.stop();
      await exec.close();
    },
  } satisfies AppRuntime;
}

function toolContext(runtime: AppRuntime): ToolContext {
  const tenant = currentTenant(); // AUTHENTICATED per-request tenant (ALS); local dev tenant otherwise
  return {
    config: runtime.config,
    tenant,
    connection: runtime.connection,
    callBudget: runtime.callBudgets.for(`linkedin-calls:${tenant.tenantId}`),
    vault: runtime.vault,
    provider: runtime.provider,
    postOps: runtime.postOps,
    publishBudget: runtime.publishBudgets.for(`publish:${tenant.tenantId}`),
    publishBudgetSql: runtime.publishBudgetSql,
    now: () => Date.now(),
    // Audit sink (M7 #12/#16): tool name + outcome only — never payloads.
    // SQL-backed in remote mode; absent in local stdio (no authStore).
    auditSink: runtime.authStore !== undefined
      ? (tool, outcome) => {
          const store = runtime.authStore;
          if (store === undefined) return Promise.resolve();
          return store.audit(tenant.tenantId, `tool:${tool}`, `tool-call:${outcome}`);
        }
      : undefined,
  };
}

function registerStatusTool(server: McpServer, runtime: AppRuntime): void {
  server.registerTool(
    'status',
    {
      title: 'Server status',
      description:
        'Reports server identity, environment, OAuth provider and LinkedIn connection state. Read-only; no LinkedIn API call.',
      inputSchema: SERVER_STATUS_SCHEMA,
    },
    async () => {
      const conn = await runtime.connection.status(runtime.tenant);
      const status: ServerStatus = {
        server: runtime.config.SERVER_NAME,
        version: runtime.config.SERVER_VERSION,
        environment: runtime.config.ENVIRONMENT,
        oauthProvider: runtime.config.OAUTH_PROVIDER,
        linkedin: conn.connected ? 'connected' : 'not-connected',
      };
      log.debug('status tool called');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status) }],
        structuredContent: status,
      };
    },
  );
}

/**
 * Audited dispatch (M7 issues #12/#16): wrap a tool call so its outcome is
 * recorded through the audit sink (tool name + ok/error, never payloads).
 * Audit failures never break the tool call — log-only.
 */
async function auditedRun(
  tool: string,
  ctx: ToolContext,
  fn: () => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const r = await fn();
    try {
      await ctx.auditSink?.(tool, r.isError === true ? 'error' : 'ok');
    } catch (auditErr) {
      log.warn('tool audit failed', { tool, error: auditErr instanceof Error ? auditErr.message : String(auditErr) });
    }
    return r;
  } catch (err) {
    try {
      await ctx.auditSink?.(tool, 'error');
    } catch { /* audit must never mask the original error */ }
    throw err;
  }
}

/**
 * Register the M2 connection tools with policy enforcement: each handler
 * funnels through its tool implementation, which runs authorize() against
 * the live connection status and applies the confirmation gate.
 */
function registerConnectionTools(server: McpServer, runtime: AppRuntime): void {
  // ctx is built PER TOOL CALL so currentTenant() resolves inside the
  // request's AsyncLocalStorage scope (authenticated tenant in remote
  // mode; LOCAL_DEV_TENANT otherwise). A snapshot here would freeze the
  // build-time tenant into every call.
  const run: (name: string) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }> = async (name) => {
    log.info('tool invoked', { tool: name });
    const ctx = toolContext(runtime);
    if (name === 'linkedin_connect') return auditedRun(name, ctx, () => connectTool(ctx));
    if (name === 'linkedin_status') return auditedRun(name, ctx, () => statusTool(ctx));
    if (name === 'linkedin_disconnect') return auditedRun(name, ctx, () => disconnectTool(ctx));
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  };
  for (const spec of CONNECTION_TOOL_SPECS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
      },
      () => run(spec.name),
    );
  }
}

/**
 * Register the M3 profile/scope tools. get_my_profile is identity-dependent:
 * its handler gates on live connection state via authorize() and sources the
 * identity from the tenant's sealed token — arguments cannot supply one.
 */
function registerProfileTools(server: McpServer, runtime: AppRuntime): void {
  // per-call ctx: currentTenant() must resolve inside the request's ALS scope
  server.registerTool(
    PROFILE_TOOL_SPEC.name,
    {
      title: PROFILE_TOOL_SPEC.title,
      description: PROFILE_TOOL_SPEC.description,
      inputSchema: PROFILE_TOOL_SPEC.inputSchema,
    },
    async () => {
      const ctx = toolContext(runtime);
      return auditedRun(PROFILE_TOOL_SPEC.name, ctx, () =>
        getMyProfileTool(ctx));
    },
  );
  server.registerTool(
    SCOPE_TOOL_SPEC.name,
    {
      title: SCOPE_TOOL_SPEC.title,
      description: SCOPE_TOOL_SPEC.description,
      inputSchema: SCOPE_TOOL_SPEC.inputSchema,
    },
    async () => {
      const ctx = toolContext(runtime);
      return auditedRun(SCOPE_TOOL_SPEC.name, ctx, () =>
        listGrantedScopesTool(ctx));
    },
  );
}

/**
 * Register the M4 publishing tools. draft/preview are local-only (no
 * provider call, no connection requirement). publish is the ONLY
 * side-effecting LinkedIn tool in the catalog: its schema forces
 * confirm:true (the confirmation gate is structural — anything else is
 * rejected by schema validation before any code runs), it re-checks
 * connection/expiry/scopes at runtime through authorize(), sources the
 * author from the sealed token's memberSub, applies the duplicate window
 * and the daily budget, and never auto-retries an uncertain write.
 */
function registerPublishTools(server: McpServer, runtime: AppRuntime): void {
  // per-call ctx: currentTenant() must resolve inside the request's ALS scope
  server.registerTool(
    DRAFT_TOOL_SPEC.name,
    {
      title: DRAFT_TOOL_SPEC.title,
      description: DRAFT_TOOL_SPEC.description,
      inputSchema: DRAFT_TOOL_SPEC.inputSchema,
    },
    (args: unknown) => {
      const ctx = toolContext(runtime);
      return auditedRun(DRAFT_TOOL_SPEC.name, ctx, () =>
        Promise.resolve(draftPostTool(ctx, DraftPostInputSchema.parse(args ?? {})) as unknown as Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>));
    },
  );
  server.registerTool(
    PREVIEW_TOOL_SPEC.name,
    {
      title: PREVIEW_TOOL_SPEC.title,
      description: PREVIEW_TOOL_SPEC.description,
      inputSchema: PREVIEW_TOOL_SPEC.inputSchema,
    },
    async (args: unknown) => {
      const ctx = toolContext(runtime);
      return auditedRun(PREVIEW_TOOL_SPEC.name, ctx, () =>
        previewPostTool(ctx, PreviewPostInputSchema.parse(args ?? {})));
    },
  );
  server.registerTool(
    PUBLISH_TOOL_SPEC.name,
    {
      title: PUBLISH_TOOL_SPEC.title,
      description: PUBLISH_TOOL_SPEC.description,
      inputSchema: PUBLISH_TOOL_SPEC.inputSchema,
    },
    async (args: unknown) => {
      const ctx = toolContext(runtime);
      return auditedRun(PUBLISH_TOOL_SPEC.name, ctx, () =>
        publishPostTool(ctx, PublishPostInputSchema.parse(args ?? {})));
    },
  );
}

export function createMcpServer(runtime: AppRuntime): McpServer {
  const server = new McpServer({
    name: runtime.config.SERVER_NAME,
    version: runtime.config.SERVER_VERSION,
    title: 'LinkedIn MCP (self-serve MVP)',
    description:
      'Authorized LinkedIn integration: sign-in profile, member posting. Search/messaging/organization capabilities are not available via self-serve APIs and are not exposed.',
  });
  registerStatusTool(server, runtime);
  registerConnectionTools(server, runtime);
  registerProfileTools(server, runtime);
  registerPublishTools(server, runtime);
  return server;
}
