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
