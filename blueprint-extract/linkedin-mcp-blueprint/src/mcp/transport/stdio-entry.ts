/**
 * stdio entry (local development + Claude Desktop config).
 * Usage: node dist/mcp/transport/stdio-entry.js
 *
 * serveStdio owns the era decision for the connection and pins one factory
 * instance per connection (2026-07-28 SDK behavior).
 */
import { loadConfig } from '../../config/config.js';
import { createLogger } from '../../observability/logger.js';
import { createMcpServer } from '../serverFactory.js';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const log = createLogger('entry:stdio');

function main(): void {
  const config = loadConfig();
  if (config.ENVIRONMENT !== 'local') {
    log.warn('stdio transport is a local-development mechanism; refusing to run', {
      environment: config.ENVIRONMENT,
    });
    process.exit(1);
  }
  serveStdio(() => createMcpServer(config), {
    onerror: (err) => {
      log.error('stdio server error', { error: err.message });
    },
  });
  log.info('stdio MCP server started', { server: config.SERVER_NAME, version: config.SERVER_VERSION });
}

main();
