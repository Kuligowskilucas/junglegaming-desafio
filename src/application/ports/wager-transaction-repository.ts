import type { WagerTransaction } from "../../domain/wagering/wager-transaction";

export abstract class WagerTransactionRepository {
  abstract add(transaction: WagerTransaction): Promise<void>;
  abstract findById(transactionId: string): Promise<WagerTransaction | undefined>;
  abstract findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  abstract hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
}
