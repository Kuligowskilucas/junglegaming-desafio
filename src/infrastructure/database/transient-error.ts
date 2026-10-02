import { ConnectionException, DeadlockException, LockWaitTimeoutException } from "@mikro-orm/core";

const transientErrorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "55P03",
  "40P01",
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
]);

export function isTransientDatabaseError(error: unknown): boolean {
  if (
    error instanceof ConnectionException ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException
  ) {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && transientErrorCodes.has(code);
}

export type LockConflict = "timeout" | "deadlock";

export function lockConflictOf(error: unknown): LockConflict | undefined {
  if (error instanceof DeadlockException) {
    return "deadlock";
  }
  if (error instanceof LockWaitTimeoutException) {
    return "timeout";
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "40P01") {
    return "deadlock";
  }
  if (code === "55P03") {
    return "timeout";
  }
  return undefined;
}
