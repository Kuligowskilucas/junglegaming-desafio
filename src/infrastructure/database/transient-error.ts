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
