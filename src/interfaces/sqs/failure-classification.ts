import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from "../../application/errors";
import { DomainError } from "../../domain/shared/domain-error";
import { InvalidMoneyError } from "../../domain/shared/money";
import { InvalidWagerTransactionError } from "../../domain/wagering/wager-transaction";
import { isTransientDatabaseError } from "../../infrastructure/database/transient-error";
import { InvalidMessageError } from "./wager-transaction-message";

export type FailureClassification =
  | { kind: "PERMANENT"; code: string; detail: string }
  | { kind: "TRANSIENT"; code: string };

export function classifyFailure(error: unknown): FailureClassification {
  if (error instanceof InvalidMessageError) {
    return { kind: "PERMANENT", code: error.code, detail: error.message };
  }
  if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError) {
    return { kind: "PERMANENT", code: error.code, detail: `${error.reason}: ${error.message}` };
  }
  if (
    error instanceof WalletNotFoundError ||
    error instanceof WalletPlayerMismatchError ||
    error instanceof IdempotencyConflictError ||
    error instanceof DuplicateExternalTransactionError ||
    error instanceof InboxPayloadMismatchError ||
    error instanceof DomainError
  ) {
    return { kind: "PERMANENT", code: error.code, detail: error.message };
  }
  return { kind: "TRANSIENT", code: isTransientDatabaseError(error) ? "DEPENDENCY_UNAVAILABLE" : "UNEXPECTED_ERROR" };
}
