import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionNotFoundError } from "../errors";
import type { WagerTransactionRepository } from "../ports/wager-transaction-repository";

export class GetWagerTransaction {
  constructor(private readonly transactions: WagerTransactionRepository) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.transactions.findById(transactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError(transactionId);
    }
    return transaction;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.transactions.findByExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError(`${externalTransactionId} of ${providerId}`);
    }
    return transaction;
  }
}
