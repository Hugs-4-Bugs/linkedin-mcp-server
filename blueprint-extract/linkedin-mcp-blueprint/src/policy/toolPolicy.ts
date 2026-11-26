/**
 * Tool policy metadata: every tool registered in the catalog carries this
 * descriptor (MCP_PROTOCOL_DESIGN.md requirement). The M1 catalog has no
 * side-effecting LinkedIn tools yet; the types exist so M2+ registrations
 * cannot skip the classification.
 */

/** Side-effect classification. */
export type EffectClass = 'read' | 'write';

/**
 * Confirmation strategy for write tools. `preview` tools render what would
 * happen; `confirmed` execution requires an explicit confirmation step
 * (owner decision D-A1: dry-run + confirmed publish).
 */
export type ConfirmationClass =
  | 'none' // read-only, no confirmation needed
  | 'dry-run-first' // write tool callable in preview mode by default
  | 'confirmation-required'; // executes only with explicit confirm=true

export interface ToolPolicy {
  /** Minimum LinkedIn scopes required (subset of LINKEDIN_SCOPES). */
  requiredScopes: readonly string[];
  effects: EffectClass;
  confirmation: ConfirmationClass;
  /** Audit hook id; usage ledger records tool name + outcome, no payloads. */
  audit: boolean;
}

export const READ_ONLY: ToolPolicy = {
  requiredScopes: [],
  effects: 'read',
  confirmation: 'none',
  audit: true,
};

/** A write tool that mutates connection state with explicit confirmation. */
export const WRITE_CONFIRMED: ToolPolicy = {
  requiredScopes: [],
  effects: 'write',
  confirmation: 'confirmation-required',
  audit: true,
};

/** A write tool whose default mode is preview (dry-run-first). */
export const WRITE_DRY_RUN_FIRST: ToolPolicy = {
  requiredScopes: [],
  effects: 'write',
  confirmation: 'dry-run-first',
  audit: true,
};

import { createLogger } from '../observability/logger.js';
import type { TenantContext } from '../identity/tenant.js';

const authzLog = createLogger('policy:authorize');

/** A linked connection as the authorization gate sees it. */
export interface ConnectionStatus {
  connected: boolean;
  scopes: readonly string[];
}

/**
 * Authorization decision input: the policy of the tool being called, the
 * caller's tenant context, and their LinkedIn connection status.
 */
export interface AuthorizeInput {
  toolName: string;
  policy: ToolPolicy;
  tenant: TenantContext;
  connection: ConnectionStatus;
}

export type AuthorizeDecision =
  | { allow: true }
  | { allow: false; code: 'not-connected' | 'insufficient-scopes'; message: string };

/**
 * The scope/confirmation gate every LinkedIn-touching tool must pass
 * (owner D-A8 tool authorization; MCP_PROTOCOL_DESIGN authorization field).
 * Called from tool registration sites in M2 — this is where ToolPolicy
 * stops being documentation and becomes enforcement.
 */
export function authorize(input: AuthorizeInput): AuthorizeDecision {
  const { toolName, policy, connection } = input;
  if (policy.requiredScopes.length > 0 && !connection.connected) {
    authzLog.info('denied: not connected', { toolName });
    return {
      allow: false,
      code: 'not-connected',
      message: 'No LinkedIn account is connected. Use the connect tool first.',
    };
  }
  const missing = policy.requiredScopes.filter((s) => !connection.scopes.includes(s));
  if (missing.length > 0) {
    authzLog.info('denied: missing scopes', { toolName, missing });
    return {
      allow: false,
      code: 'insufficient-scopes',
      message: `This tool requires LinkedIn scopes not granted: ${missing.join(', ')}.`,
    };
  }
  return { allow: true };
}
