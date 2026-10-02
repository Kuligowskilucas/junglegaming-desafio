import { isTransientDatabaseError } from "../../infrastructure/database/transient-error";

export function failureReason(error: unknown): string {
  return isTransientDatabaseError(error) ? "DEPENDENCY_UNAVAILABLE" : "UNEXPECTED_ERROR";
}
