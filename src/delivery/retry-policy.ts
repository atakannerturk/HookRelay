/**
 * Retry strategy: a fixed delay table (1s, 5s, 30s, 5min ...) plus optional jitter.
 * A table is easier to reason about than pure exponential backoff and is close to what
 * providers such as Stripe and GitHub do.
 */
export class RetryPolicy {
  constructor(
    readonly maxAttempts: number,
    private readonly delaysMs: readonly number[],
    private readonly jitter = 0,
  ) {
    if (delaysMs.length === 0) throw new Error('At least one retry delay is required');
  }

  /** How many ms to wait after attempt number `attempt` (1-based) has failed. */
  delayAfter(attempt: number, random: () => number = Math.random): number {
    const index = Math.min(Math.max(attempt, 1), this.delaysMs.length) - 1;
    const base = this.delaysMs[index];
    if (this.jitter === 0) return base;
    // Keep thousands of deliveries that failed together from retrying in lockstep (thundering herd).
    const spread = base * this.jitter;
    return Math.max(0, Math.round(base - spread + random() * 2 * spread));
  }

  isFinal(attempt: number): boolean {
    return attempt >= this.maxAttempts;
  }
}

export type ResponseClass = 'success' | 'retryable' | 'permanent';

/**
 * 2xx is success. 408/429 and 5xx are treated as transient and retried. Any other 4xx (and
 * the 3xx redirects we refuse to follow) is a misconfigured destination: sending the same
 * request again will not change the outcome, so it goes straight to the dead-letter list.
 */
export function classifyStatus(status: number): ResponseClass {
  if (status >= 200 && status < 300) return 'success';
  if (status === 408 || status === 429 || status >= 500) return 'retryable';
  return 'permanent';
}
