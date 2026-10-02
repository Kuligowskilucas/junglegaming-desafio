import { InvalidOperationError } from "../shared/domain-error";
import type { MoneyProps } from "../shared/money";
import type { WagerTransaction } from "../wagering/wager-transaction";
import { WagerTransactionStatus } from "../wagering/wager-transaction-status";
import type { EventContext } from "./event-context";
import { IntegrationEvent } from "./integration-event";
import { type WagerTransactionEventData, wagerTransactionEventData } from "./wager-transaction-event-data";

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    const { observedBalance, processedAt, referenceTransactionId } = transaction;
    if (transaction.status !== WagerTransactionStatus.Processed || !observedBalance || !processedAt) {
      throw new InvalidOperationError(`Transaction ${transaction.id} is not processed`);
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      orderingKey: transaction.walletId,
      data: {
        ...wagerTransactionEventData(transaction),
        ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
        balanceAfter: observedBalance.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}
