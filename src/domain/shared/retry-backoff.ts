export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export function backoffDelayMs(policy: BackoffPolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

export function nextAttemptAt(policy: BackoffPolicy, attempt: number, now: Date): Date {
  return new Date(now.getTime() + backoffDelayMs(policy, attempt));
}
