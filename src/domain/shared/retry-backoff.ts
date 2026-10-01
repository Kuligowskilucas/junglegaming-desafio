export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export function nextAttemptAt(policy: BackoffPolicy, attempt: number, now: Date): Date {
  const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return new Date(now.getTime() + delayMs);
}
