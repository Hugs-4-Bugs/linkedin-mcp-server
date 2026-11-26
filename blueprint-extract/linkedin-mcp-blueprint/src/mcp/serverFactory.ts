/**
 * Server factory: builds the McpServer instance with the tool catalog
 * attached. One factory for both transports (ADR-006): no transport-specific
 * behavior may leak into tool implementations.
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AppConfig } from '../config/config.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('mcp:server');

/** M1 catalog: server health/status only. LinkedIn tools land in M3/M4. */
const SERVER_STATUS_SCHEMA = z.object({}).strict();

export interface ServerStatus {
  server: string;
  version: string;
  environment: string;
  linkedin: 'not-configured'; // M2 introduces real connection state
}

function registerStatusTool(server: McpServer, config: AppConfig): void {
  // READ_ONLY policy metadata documented at registration site; enforcement
  // lands with M2 authz (src/policy/toolPolicy.ts).
  server.registerTool(
    'status',
    {
      title: 'Server status',
      description:
        'Reports server identity, environment and LinkedIn connection state. Read-only; no LinkedIn API call.',
      inputSchema: SERVER_STATUS_SCHEMA,
    },
    async () => {
      const status: ServerStatus = {
        server: config.SERVER_NAME,
        version: config.SERVER_VERSION,
        environment: config.ENVIRONMENT,
        linkedin: 'not-configured',
      };
      log.debug('status tool called');
      await Promise.resolve(); // keep async signature; M2+ handlers become truly async
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status) }],
        structuredContent: status,
      };
    },
  );
}

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer({
    name: config.SERVER_NAME,
    version: config.SERVER_VERSION,
    title: 'LinkedIn MCP (self-serve MVP)',
    description:
      'Authorized LinkedIn integration: sign-in profile, member posting. Search/messaging/organization capabilities are not available via self-serve APIs and are not exposed.',
  });
  registerStatusTool(server, config);
  return server;
}
