import { defineEntity, type InferEntity, p } from "@mikro-orm/core";
import { FailureCode } from "../../../domain/wagering/failure-code";
import { WagerTransactionKind } from "../../../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status";

export const WagerTransactionRecord = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    correlationId: p.text(),
    payloadHash: p.string(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.enum(() => WagerTransactionKind),
    amount: p.decimal(),
    currency: p.string(),
    referenceExternalTransactionId: p.text().nullable(),
    status: p.enum(() => WagerTransactionStatus),
    referenceTransactionId: p.uuid().nullable(),
    failureCode: p.enum(() => FailureCode).nullable(),
    observedBalance: p.decimal().nullable(),
    referenceAttempts: p.integer(),
    nextReferenceAttemptAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;
