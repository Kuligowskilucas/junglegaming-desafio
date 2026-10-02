import type { SubmissionResult } from "../../../application/wagering/submit-wager-transaction";
import type { MoneyProps } from "../../../domain/shared/money";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status";
import { problemDetails } from "../errors/problem-details";

export interface SubmissionReply {
  status: number;
  contentType: string | undefined;
  body: unknown;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: string | null;
  balance: MoneyProps | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}

export function presentSubmission(
  result: SubmissionResult,
  request: { instance: string; correlationId: string | undefined },
): SubmissionReply {
  const { transaction, idempotentReplay } = result;
  const outcome = {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON() ?? null,
    idempotentReplay,
  };
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return { status: 200, contentType: undefined, body: outcome };
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return { status: 202, contentType: undefined, body: outcome };
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed: {
      const failureCode = transaction.failureCode ?? "UNKNOWN_FAILURE";
      const rejected = transaction.status === WagerTransactionStatus.Rejected;
      return {
        status: rejected ? 422 : 500,
        contentType: "application/problem+json",
        body: problemDetails(
          {
            status: rejected ? 422 : 500,
            code: failureCode,
            title: rejected ? "Wager transaction rejected" : "Wager transaction failed",
            detail: `Transaction ${transaction.id} ended ${transaction.status} with ${failureCode}`,
            extensions: {
              transactionId: transaction.id,
              transactionStatus: transaction.status,
              failureCode,
              balance: outcome.balance,
              idempotentReplay,
            },
          },
          request,
        ),
      };
    }
  }
}

export function presentWagerTransaction(transaction: WagerTransaction): WagerTransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.observedBalance?.toJSON() ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    updatedAt: transaction.updatedAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
