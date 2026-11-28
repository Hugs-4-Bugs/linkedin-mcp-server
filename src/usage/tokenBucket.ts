/**
 * Usage metering seam (blueprint `usage/`): fixed-window token bucket used as
 * the rate-limit gate for OAuth flows and (later) LinkedIn API calls.
 * In-memory implementation; Postgres-backed ledger arrives with M5 hosting.
 *
 * Blueprint/owner mapping: owner D-A8 rate limiting; LinkedIn share limits
 * (150 req/member/day) are enforced at the M4 tool layer with this bucket.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('usage:bucket');

export interface TokenBucketOptions {
  /** Bucket identity (per-tenant/per-action keys come from the caller). */
  key: string;
  capacity: number;
  /** Window length in ms. */
  windowMs: number;
}

export class TokenBucket {
  private readonly hits: number[] = [];

  constructor(
    private readonly opts: TokenBucketOptions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns true and consumes a token, or returns false when exhausted. */
  take(): boolean {
    const cutoff = this.now() - this.opts.windowMs;
    while (this.hits.length > 0 && (this.hits[0] ?? 0) <= cutoff) {
      this.hits.shift();
    }
    if (this.hits.length >= this.opts.capacity) {
      log.debug('bucket exhausted', { key: this.opts.key, capacity: this.opts.capacity });
      return false;
    }
    this.hits.push(this.now());
    return true;
  }

  /** Number of tokens currently available. */
  available(): number {
    const cutoff = this.now() - this.opts.windowMs;
    while (this.hits.length > 0 && (this.hits[0] ?? 0) <= cutoff) {
      this.hits.shift();
    }
    return this.opts.capacity - this.hits.length;
  }
}

/** Registry of buckets keyed by caller-supplied identity strings. */
export class BucketRegistry {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly defaults: { capacity: number; windowMs: number },
    private readonly now: () => number = () => Date.now(),
  ) {}

  for(key: string): TokenBucket {
    let b = this.buckets.get(key);
    if (b === undefined) {
      b = new TokenBucket({ key, ...this.defaults }, this.now);
      this.buckets.set(key, b);
    }
    return b;
  }
}
