import { Money } from "../../../domain/shared/money";
import { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import type { WagerTransactionRecord } from "../records/wager-transaction.record";

export const wagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const money = Money.from({ amount: record.amount, currency: record.currency });
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money,
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      status: record.status,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode: record.failureCode ?? undefined,
      observedBalance:
        record.observedBalance == null
          ? undefined
          : Money.from({ amount: record.observedBalance, currency: record.currency }),
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      processedAt: record.processedAt ?? undefined,
    });
  },

  toRecord(transaction: WagerTransaction): WagerTransactionRecord {
    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.toJSON().amount,
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      status: transaction.status,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      observedBalance: transaction.observedBalance?.toJSON().amount ?? null,
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
      processedAt: transaction.processedAt ?? null,
    };
  },
};
