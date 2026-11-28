/**
 * Master assignment step 14 — user-controlled autonomy: tier model.
 *
 * Every consequential tool/action class maps to a tier; the tier decides
 * what enforcement is REQUIRED before execution. The model is a pure
 * policy check (no I/O) so it can be applied at every dispatch point
 * and tested exhaustively.
 *
 * Tier A — READ: analysis, discovery, research. No confirmation.
 * Tier B — PREPARE: drafts, previews, recommendations. No side effects
 *          on LinkedIn; no confirmation (the artifact is returned, the
 *          human decides).
 * Tier C — AUTONOMOUS EXECUTION: bounded, durable, user-configured
 *          automation (scheduled posts). Requires: explicit confirm at
 *          creation, durable queue, cancellation, bounded retries, full
 *          safety stack at fire time, audit records.
 * Tier D — HIGH-IMPACT: irreversible/consequential actions (job
 *          applications, consequential messaging, anything touching a
 *          third party beyond the user's own account). Currently NO
 *          tool occupies this tier — LinkedIn does not offer supported
 *          APIs for these classes; the model exists so any future tool
 *          is forced to declare it and to require per-action human
 *          confirmation + narrowly-configured authorization.
 *
 * External content (posts, messages, job descriptions, profiles) can
 * NEVER relax a tier: classify() takes only the action class + flags,
 * never payload text. Tiers are properties of the ACTION, not of the
 * data flowing through it — the defense against prompt injection at
 * the policy layer.
 */
export type AutonomyTier = 'A' | 'B' | 'C' | 'D';

export interface TierPolicy {
  readonly tier: AutonomyTier;
  readonly label: string;
  /** Structural confirmation required at the tool schema (confirm:true). */
  readonly requiresConfirmation: boolean;
  /** Side effects on LinkedIn or third parties. */
  readonly sideEffects: 'none' | 'self-account' | 'third-party';
  /** Must run through a durable, cancellable, bounded-retry mechanism. */
  readonly durableExecutionRequired: boolean;
  /** Per-action human confirmation even when configured autonomously. */
  readonly perActionConfirmation: boolean;
}

export const TIERS: Readonly<Record<AutonomyTier, TierPolicy>> = {
  A: {
    tier: 'A', label: 'read-and-analyze',
    requiresConfirmation: false, sideEffects: 'none',
    durableExecutionRequired: false, perActionConfirmation: false,
  },
  B: {
    tier: 'B', label: 'prepare',
    requiresConfirmation: false, sideEffects: 'none',
    durableExecutionRequired: false, perActionConfirmation: false,
  },
  C: {
    tier: 'C', label: 'authorized-execution',
    requiresConfirmation: true, sideEffects: 'self-account',
    durableExecutionRequired: true, perActionConfirmation: false,
  },
  D: {
    tier: 'D', label: 'high-impact',
    requiresConfirmation: true, sideEffects: 'third-party',
    durableExecutionRequired: false, perActionConfirmation: true,
  },
};

/** The tool-catalog tier assignment. One place, exhaustive, test-enforced
 * to cover every registered tool — a new tool cannot ship unclassified. */
export const TOOL_TIERS: Readonly<Record<string, AutonomyTier>> = {
  status: 'A',
  // connect initiates a 3-party OAuth redirect: the human confirms the
  // action BY COMPLETING the provider's consent screen — a stronger
  // per-action gate than any schema literal. Tier C by consequence.
  linkedin_connect: 'C',
  linkedin_status: 'A',
  linkedin_disconnect: 'C',
  linkedin_get_my_profile: 'A',
  linkedin_list_granted_scopes: 'A',
  linkedin_draft_post: 'B',
  linkedin_preview_post: 'B',
  linkedin_publish_post: 'C',
  linkedin_schedule_post: 'C',
  linkedin_list_scheduled_posts: 'A',
  linkedin_cancel_scheduled_post: 'C',
};

export interface TierDecision {
  readonly allowed: boolean;
  readonly tier: AutonomyTier;
  readonly policy: TierPolicy;
  readonly reason?: string;
}

/**
 * Decide whether an action class may run under the supplied controls.
 * Pure function of (tool, confirmFlag, durable). Payload content is
 * deliberately not an input — external text cannot change a decision.
 */
export function classify(tool: string, input: { confirm?: boolean; durable?: boolean }): TierDecision {
  const tier = TOOL_TIERS[tool];
  if (tier === undefined) {
    // Unknown tools are not "tier A by default": they are REFUSED. An
    // unclassified action has no policy evidence; failing closed is the
    // only safe default.
    return {
      allowed: false,
      tier: 'D',
      policy: TIERS.D,
      reason: `tool not classified in the autonomy tier catalog: ${tool}`,
    };
  }
  const policy = TIERS[tier];
  if (policy.requiresConfirmation && input.confirm !== true) {
    return { allowed: false, tier, policy, reason: `${tool} is tier ${tier} (${policy.label}): explicit confirm:true required` };
  }
  if (policy.durableExecutionRequired && input.durable === false) {
    return { allowed: false, tier, policy, reason: `${tool} requires durable execution infrastructure` };
  }
  return { allowed: true, tier, policy };
}

/** Tier of a tool, or undefined when unclassified (callers treat as fail-closed). */
export function tierOf(tool: string): AutonomyTier | undefined {
  return TOOL_TIERS[tool];
}
