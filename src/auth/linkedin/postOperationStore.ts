/**
 * Local publication operation tracking (M4 write-safety).
 *
 * Verified Phase 2 finding: LinkedIn's Posts API provides NO idempotency
 * mechanism (no idempotency-key header documented). The only duplicate-
 * related server behavior is a 422 "exact duplicate of recently created
 * post" response, which is not a contract we can rely on. Therefore this
 * store implements LOCAL duplicate protection with honestly documented
 * limits (ADR-016):
 *
 *  - content-hash dedup: identical text within the TTL window is refused
 *    locally instead of being sent twice;
 *  - in-flight lock: a publish already running for the same tenant+hash is
 *    refused rather than queued (prevents concurrent double-submits);
 *  - outcome ledger: success (post URN recorded), failure (provider said
 *    no), ambiguous (timeout after the provider may have accepted it).
 *    Ambiguous outcomes mark the hash as SUSPECT: we do NOT know whether
 *    LinkedIn accepted the post, so we refuse the same content re-submit
 *    for the TTL window and tell the caller to verify out-of-band. This is
 *  - NOT exactly-once publishing. A timeout after acceptance, a restart, or
 *    a second different process can each still produce a duplicate. The
 *    store is in-memory (same lifetime as the rest of the M2/M3 state;
 *    Postgres ledger is M5 scope).
 */
import { createHash } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('publish:opstore');

export const POST_FINGERPRINT_ALGORITHM = 'sha256';

/** Fingerprint post content without storing or echoing the text itself. */
export function fingerprintPostText(text: string): string {
  return createHash(POST_FINGERPRINT_ALGORITHM).update(text, 'utf8').digest('hex');

}

export type PublishOutcome = 'success' | 'failure' | 'ambiguous';

export type OpRecordState = 'in-flight' | PublishOutcome;

interface OpRecord {
  state: OpRecordState;
  /** Post URN from the provider (success only). */
  postUrn?: string;
  startedAt: number;
  endedAt?: number | undefined;
  attempts: number;
}

export class DuplicateOperationError extends Error {
  constructor(
    readonly reason: 'in-flight' | 'recent-identical' | 'suspect-after-ambiguous',
    message: string,
  ) {
    super(message);
    this.name = 'DuplicateOperationError';
  }
}

export interface PostOperationStoreOptions {
  /** How long identical content is refused after a completed attempt. */
  duplicateWindowMs: number;
  now?: () => number;
}

export class PostOperationStore {
  private readonly records = new Map<string, OpRecord>();

  constructor(private readonly opts: PostOperationStoreOptions) {}

  private key(tenantId: string, hash: string): string {
    return `${tenantId}:${hash}`;
  }

  /**
   * Enter a publish attempt for (tenant, content hash). Throws
   * DuplicateOperationError when an identical attempt is in flight or a
   * completed attempt for the same content is inside the duplicate window
   * (ambiguous outcomes included — re-submitting blind is exactly how
   * duplicate posts get created).
   */
  enter(tenantId: string, hash: string): void {
    const k = this.key(tenantId, hash);
    const rec = this.records.get(k);
    const now = this.opts.now?.() ?? Date.now();
    if (rec) {
      if (rec.state === 'in-flight') {
        throw new DuplicateOperationError(
          'in-flight',
          'An identical publish operation is already in progress for this account.',
        );
      }
      const finishedAt = rec.endedAt ?? rec.startedAt;
      const age = now - finishedAt;
      if (age < this.opts.duplicateWindowMs) {
        if (rec.state === 'ambiguous') {
          throw new DuplicateOperationError(
            'suspect-after-ambiguous',
            'A previous attempt of this exact content timed out after the provider may have accepted it. Verify whether the post exists on LinkedIn before retrying.',
          );
        }
        if (rec.state === 'success') {
          throw new DuplicateOperationError(
            'recent-identical',
            'This exact post content was already published recently.',
          );
        }
        // failure: allowed to retry (provider definitively refused), but
        // the attempt count is still tracked on the same record.
        rec.attempts += 1;
        rec.state = 'in-flight';
        rec.startedAt = now;
        rec.endedAt = undefined as number | undefined;
        log.info('retry after provider failure', { tenant: tenantId, attempt: rec.attempts });
        return;
      }
    }
    this.records.set(k, {
      state: 'in-flight',
      startedAt: now,
      attempts: rec ? rec.attempts + 1 : 1,
    });
  }

  /** Record the outcome of a publish attempt. */
  exit(tenantId: string, hash: string, outcome: PublishOutcome, postUrn?: string): void {
    const k = this.key(tenantId, hash);
    const rec = this.records.get(k);
    if (rec === undefined) {
      // Defensive: enter() was not called (programmer error, not user input)
      log.warn('exit without matching enter', { tenant: tenantId });
      return;
    }
    rec.state = outcome;
    rec.endedAt = this.opts.now?.() ?? Date.now();
    if (postUrn !== undefined) rec.postUrn = postUrn;
    if (outcome === 'ambiguous') {
      log.warn('ambiguous publish outcome recorded', { tenant: tenantId });
    }
  }

  /** Test hook: state of the record for (tenant, hash), if any. */
  stateOf(tenantId: string, hash: string): OpRecordState | undefined {
    return this.records.get(this.key(tenantId, hash))?.state;
  }

  /** Prune records whose windows elapsed (keeps the map bounded). */
  prune(): void {
    const now = this.opts.now?.() ?? Date.now();
    for (const [k, rec] of this.records) {
      const finishedAt = rec.endedAt ?? rec.startedAt;
      if (rec.state !== 'in-flight' && now - finishedAt >= this.opts.duplicateWindowMs) {
        this.records.delete(k);
      }
    }
  }
}
