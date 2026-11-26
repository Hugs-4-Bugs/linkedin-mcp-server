/**
 * M2 tool catalog: connection lifecycle tools.
 *
 *  - connect:     starts the 3LO flow, returns the authorization URL (read-ish
 *                  side effect; no confirmation gate but rate-limited)
 *  - status:      connection status for the tenant (read-only)
 *  - disconnect:   write tool with CONFIRMATION gate (owner D-A1 deletion path)
 *
 * Enforcement wiring: every tool call passes through authorize() with the
 * tool's ToolPolicy and the tenant's live connection status. The
 * confirmation gate for disconnect mirrors what publish_post will use in M4.
 */
import * as z from 'zod/v4';
import { createLogger } from '../observability/logger.js';
import {
  authorize,
  READ_ONLY,
  WRITE_CONFIRMED,
  type ToolPolicy,
} from '../policy/toolPolicy.js';
import type { ToolContext } from './toolContext.js';
import { CallbackError, RateLimitError } from '../auth/linkedin/connectionService.js';

const log = createLogger('tools:connection');

export const ConnectInputSchema = z.object({}).strict();
export const StatusInputSchema = z.object({}).strict();
export const DisconnectInputSchema = z
  .object({
    /** Confirmation required (WRITE_CONFIRMED policy). */
    confirm: z.literal(true),
  })
  .strict();

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function textResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export interface RegisteredToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  policy: ToolPolicy;
}

/** Catalog metadata (also consumed by tests). */
export const CONNECTION_TOOL_SPECS: RegisteredToolSpec[] = [
  {
    name: 'linkedin_connect',
    title: 'Start LinkedIn connection',
    description:
      'Starts the LinkedIn authorization flow for this tenant and returns the authorization URL to open in a browser. Rate-limited. Read the URL aloud; do not fetch it.',
    inputSchema: ConnectInputSchema,
    policy: READ_ONLY,
  },
  {
    name: 'linkedin_status',
    title: 'LinkedIn connection status',
    description:
      'Reports whether a LinkedIn account is connected, the token expiry, granted scopes and the member id. Read-only.',
    inputSchema: StatusInputSchema,
    policy: READ_ONLY,
  },
  {
    name: 'linkedin_disconnect',
    title: 'Disconnect LinkedIn account',
    description:
      'Deletes this tenant\'s stored LinkedIn tokens (account disconnection). Write action; requires confirm=true to execute.',
    inputSchema: DisconnectInputSchema,
    policy: WRITE_CONFIRMED,
  },
];

/** Connect tool: start flow, return URL + state. No authz gate needed (READ_ONLY policy). */
export function connectTool(ctx: ToolContext): ToolResult {
  try {
    const start = ctx.connection.connect(ctx.tenant);
    return textResult({
      authorizationUrl: start.authorizationUrl,
      state: start.state,
      note: 'Open the authorization URL in a browser and complete the LinkedIn consent; the callback stores the tokens.',
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return errorResult('Connection flow rate limit reached (6 per 10 minutes). Try again later.');
    }
    log.error('connect tool failed', { error: err instanceof Error ? err.message : String(err) });
    return errorResult('Failed to start the connection flow.');
  }
}

/** Status tool: live connection status. */
export async function statusTool(ctx: ToolContext): Promise<ToolResult> {
  const status = await ctx.connection.status(ctx.tenant);
  return textResult({
    ...status,
    expiresAt: status.expiresAt,
    expiresInDays: status.expiresAt !== null
      ? Math.max(0, Math.round((status.expiresAt - Date.now()) / 86_400_000))
      : null,
  });
}

/** Disconnect tool: confirmation-gated token deletion. */
export async function disconnectTool(ctx: ToolContext): Promise<ToolResult> {
  const status = await ctx.connection.status(ctx.tenant);
  const decision = authorize({
    toolName: 'linkedin_disconnect',
    policy: WRITE_CONFIRMED,
    tenant: ctx.tenant,
    connection: status,
  });
  if (!decision.allow) return errorResult(decision.message);
  // The DisconnectInputSchema forces confirm: z.literal(true), so a runtime
  // check is unreachable via the SDK path; the schema IS the confirmation gate.
  const had = await ctx.connection.disconnect(ctx.tenant);
  return textResult({
    disconnected: true,
    hadTokens: had,
  });
}

/** Map CallbackError codes to user-safe messages (used by route tests). */
export function describeCallbackError(err: CallbackError): string {
  if (err.code === 'state') {
    return 'Invalid or expired authorization state; restart the connection flow.';
  }
  return 'LinkedIn authorization failed; retry the connection flow.';
}
