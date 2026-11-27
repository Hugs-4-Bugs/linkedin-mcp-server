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
  vault: InMemoryTokenVault;
  callBudgets: BucketRegistry;
  /** OAuth provider in use (mock or real); tools receive it via ToolContext. */
  provider: LinkedInOAuthProvider;
  /** Present only when OAUTH_PROVIDER=mock (route-level mock consent flow). */
  mockProvider: LinkedInMockProvider | undefined;
  /** Publication operation ledger (M4, ADR-016). */
  postOps: PostOperationStore;
  /** Per-tenant daily publish budget (application safety limit, ADR-015). */
  publishBudgets: BucketRegistry;
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
  } satisfies AppRuntime;
}

function toolContext(runtime: AppRuntime): ToolContext {
  return {
    config: runtime.config,
    tenant: runtime.tenant,
    connection: runtime.connection,
    callBudget: runtime.callBudgets.for(`linkedin-calls:${runtime.tenant.tenantId}`),
    vault: runtime.vault,
    provider: runtime.provider,
    postOps: runtime.postOps,
    publishBudget: runtime.publishBudgets.for(`publish:${runtime.tenant.tenantId}`),
    now: () => Date.now(),
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
 * Register the M2 connection tools with policy enforcement: each handler
 * funnels through its tool implementation, which runs authorize() against
 * the live connection status and applies the confirmation gate.
 */
function registerConnectionTools(server: McpServer, runtime: AppRuntime): void {
  const ctx = toolContext(runtime);
  const run: (name: string) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }> = async (name) => {
    log.info('tool invoked', { tool: name });
    if (name === 'linkedin_connect') return connectTool(ctx);
    if (name === 'linkedin_status') return statusTool(ctx);
    if (name === 'linkedin_disconnect') return disconnectTool(ctx);
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
  const ctx = toolContext(runtime);
  server.registerTool(
    PROFILE_TOOL_SPEC.name,
    {
      title: PROFILE_TOOL_SPEC.title,
      description: PROFILE_TOOL_SPEC.description,
      inputSchema: PROFILE_TOOL_SPEC.inputSchema,
    },
    async () => {
      const r = await getMyProfileTool(ctx);
      return r as unknown as { content: { type: 'text'; text: string }[] };
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
      const r = await listGrantedScopesTool(ctx);
      return r as unknown as { content: { type: 'text'; text: string }[] };
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
  const ctx = toolContext(runtime);
  server.registerTool(
    DRAFT_TOOL_SPEC.name,
    {
      title: DRAFT_TOOL_SPEC.title,
      description: DRAFT_TOOL_SPEC.description,
      inputSchema: DRAFT_TOOL_SPEC.inputSchema,
    },
    (args: unknown) => {
      const r = draftPostTool(ctx, DraftPostInputSchema.parse(args ?? {}));
      return Promise.resolve(r as unknown as { content: { type: 'text'; text: string }[] });
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
      const r = await previewPostTool(ctx, PreviewPostInputSchema.parse(args ?? {}));
      return r as unknown as { content: { type: 'text'; text: string }[] };
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
      const r = await publishPostTool(ctx, PublishPostInputSchema.parse(args ?? {}));
      return r as unknown as { content: { type: 'text'; text: string }[] };
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
