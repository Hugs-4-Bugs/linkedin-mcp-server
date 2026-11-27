/**
 * Verified publication result contract (M4 Phase 2).
 *
 * Official Posts API create behavior: HTTP 201 with an empty body; the post
 * URN arrives in the `x-restli-id` response header (shape urn:li:share:…
 * or urn:li:ugcPost:…). No success JSON body is documented — a body that
 * claims success must NOT be trusted as an alternative URN source.
 *
 * Ambiguity: when the request fails in a way that leaves the outcome
 * unknown (timeout after send, network drop after send, 5xx), the
 * publication may or may not exist. Represented as `ambiguous: true` with
 * no postUrn, never as success or failure.
 */
import { createHash } from 'node:crypto';

/** URN namespaces the verified API returns for created posts. */
const POST_URN_PATTERN = /^urn:li:(share|ugcPost):[0-9]+$/;

export interface PublishResult {
  /** True when LinkedIn confirmed creation (201 + x-restli-id). */
  confirmed: boolean;
  /** Post URN from x-restli-id; present only when confirmed. */
  postUrn?: string;
  /** Provider could not determine the outcome (timeout/5xx/network). */
  ambiguous: boolean;
  /** HTTP status when known. */
  status?: number;
}

export class PublishResultValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PublishResultValidationError';
  }
}

/** Validate a provider-supplied publish outcome; throws on impossible shapes. */
export function validatePublishResult(input: {
  confirmed: boolean;
  postUrn?: string | undefined;
  ambiguous?: boolean | undefined;
  status?: number | undefined;
}): PublishResult {
  if (typeof input.confirmed !== 'boolean') {
    throw new PublishResultValidationError('confirmed must be a boolean');
  }
  if (input.confirmed) {
    if (input.ambiguous === true) {
      throw new PublishResultValidationError('confirmed result cannot be ambiguous');
    }
    if (typeof input.postUrn !== 'string' || !POST_URN_PATTERN.test(input.postUrn)) {
      throw new PublishResultValidationError('confirmed result requires a valid post URN');
    }
  } else if (input.postUrn !== undefined) {
    throw new PublishResultValidationError('unconfirmed result cannot carry a post URN');
  }
  return {
    confirmed: input.confirmed,
    ...(input.postUrn !== undefined ? { postUrn: input.postUrn } : {}),
    ambiguous: input.ambiguous === true,
    ...(input.status !== undefined ? { status: input.status } : {}),
  };
}

/**
 * Fingerprint a post URN for logs/assertions without printing the raw URN
 * (URNs are not secrets, but stable habits beat per-case judgment).
 */
export function fingerprintPostUrn(postUrn: string): string {
  return createHash('sha256').update(postUrn).digest('base64url').slice(0, 12);
}
