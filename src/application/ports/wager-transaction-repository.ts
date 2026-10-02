import type { WagerTransaction } from "../../domain/wagering/wager-transaction";

export interface DueReferenceRetry {
  transactionId: string;
  walletId: string;
}

export abstract class WagerTransactionRepository {
  abstract add(transaction: WagerTransaction): Promise<void>;
  abstract update(transaction: WagerTransaction): Promise<void>;
  abstract findById(transactionId: string): Promise<WagerTransaction | undefined>;
  abstract findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  abstract hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  abstract findDueForReferenceRetry(now: Date, limit: number): Promise<DueReferenceRetry[]>;
  abstract rescheduleDependentsOf(providerId: string, externalTransactionId: string, at: Date): Promise<number>;
}
