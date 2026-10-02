import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { HttpAdapterHost } from "@nestjs/core";
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  WagerTransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from "../../../application/errors";
import { DomainError } from "../../../domain/shared/domain-error";
import { InvalidMoneyError } from "../../../domain/shared/money";
import { InvalidWagerTransactionError } from "../../../domain/wagering/wager-transaction";
import { isTransientDatabaseError } from "../../../infrastructure/database/transient-error";
import { InvalidCursorError } from "../wallets/ledger-cursor";
import { MissingIdempotencyKeyError } from "./missing-idempotency-key.error";
import { type ProblemDescription, problemDetails } from "./problem-details";
import { RequestValidationError } from "./request-validation.error";

const retryAfterSeconds = "1";

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ originalUrl?: string; url?: string; id?: unknown }>();
    const response = http.getResponse<unknown>();
    const description = this.describe(exception);
    const problem = problemDetails(description, {
      instance: request.originalUrl ?? request.url ?? "",
      correlationId: typeof request.id === "string" ? request.id : undefined,
    });
    if (problem.status >= 500) {
      this.logger.error({ err: exception, code: problem.code }, "Request failed");
    }
    if (exception instanceof WalletPlayerMismatchError) {
      this.logger.warn(
        { playerId: exception.playerId, code: problem.code },
        "Wager transaction refused: the player does not own the wallet",
      );
    }
    const adapter = this.adapterHost.httpAdapter;
    adapter.setHeader(response, "Content-Type", "application/problem+json");
    if (problem.retryable) {
      adapter.setHeader(response, "Retry-After", retryAfterSeconds);
    }
    adapter.reply(response, problem, problem.status);
  }

  private describe(exception: unknown): ProblemDescription {
    if (exception instanceof RequestValidationError) {
      return {
        status: 400,
        code: "VALIDATION_FAILED",
        title: "Request validation failed",
        detail: "The request does not match the expected schema",
        extensions: { errors: exception.issues },
      };
    }
    if (exception instanceof MissingIdempotencyKeyError) {
      return {
        status: 400,
        code: "MISSING_IDEMPOTENCY_KEY",
        title: "Missing Idempotency-Key",
        detail: exception.message,
      };
    }
    if (exception instanceof InvalidCursorError) {
      return { status: 400, code: "INVALID_CURSOR", title: "Invalid cursor", detail: exception.message };
    }
    if (exception instanceof InvalidMoneyError) {
      return {
        status: 400,
        code: "INVALID_MONEY",
        title: "Invalid money",
        detail: exception.message,
        extensions: { reason: exception.reason },
      };
    }
    if (exception instanceof InvalidWagerTransactionError) {
      return {
        status: 400,
        code: "INVALID_WAGER_TRANSACTION",
        title: "Invalid wager transaction",
        detail: exception.message,
        extensions: { reason: exception.reason },
      };
    }
    if (exception instanceof DomainError) {
      return { status: 400, code: exception.code, title: "Invalid request", detail: exception.message };
    }
    if (exception instanceof WalletNotFoundError) {
      return { status: 404, code: exception.code, title: "Wallet not found", detail: exception.message };
    }
    if (exception instanceof WagerTransactionNotFoundError) {
      return { status: 404, code: exception.code, title: "Transaction not found", detail: exception.message };
    }
    if (exception instanceof IdempotencyConflictError) {
      return {
        status: 409,
        code: exception.code,
        title: "Idempotency key conflict",
        detail: exception.message,
        extensions: { transactionId: exception.existingTransactionId },
      };
    }
    if (exception instanceof DuplicateExternalTransactionError) {
      return {
        status: 409,
        code: exception.code,
        title: "Duplicate external transaction id",
        detail: exception.message,
        extensions: { transactionId: exception.existingTransactionId },
      };
    }
    if (exception instanceof WalletPlayerMismatchError) {
      return { status: 422, code: exception.code, title: "Player does not own the wallet", detail: exception.message };
    }
    if (exception instanceof WalletAlreadyExistsError) {
      return {
        status: 409,
        code: exception.code,
        title: "Wallet already exists",
        detail: exception.message,
        extensions: { walletId: exception.existingWalletId },
      };
    }
    if (isTransientDatabaseError(exception)) {
      return {
        status: 503,
        code: "DEPENDENCY_UNAVAILABLE",
        title: "Dependency unavailable",
        detail: "A required dependency is temporarily unavailable, retry the same request later",
        retryable: true,
      };
    }
    if (exception instanceof HttpException) {
      return this.describeHttpException(exception);
    }
    if (isMalformedBody(exception)) {
      return { status: 400, code: "MALFORMED_REQUEST", title: "Malformed request", detail: "The request body is not valid JSON" };
    }
    return { status: 500, code: "INTERNAL_ERROR", title: "Internal error", detail: "Unexpected error" };
  }

  private describeHttpException(exception: HttpException): ProblemDescription {
    const status = exception.getStatus();
    if (status === 404) {
      return { status, code: "ROUTE_NOT_FOUND", title: "Route not found", detail: "No route matches this request" };
    }
    if (status === 400) {
      return { status, code: "MALFORMED_REQUEST", title: "Malformed request", detail: exception.message };
    }
    return { status, code: `HTTP_${status}`, title: exception.name, detail: exception.message };
  }
}

function isMalformedBody(exception: unknown): boolean {
  return (exception as { type?: unknown } | null)?.type === "entity.parse.failed";
}
