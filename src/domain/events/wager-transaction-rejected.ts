import { InvalidOperationError } from "../shared/domain-error";
import type { MoneyProps } from "../shared/money";
import type { FailureCode } from "../wagering/failure-code";
import type { WagerTransaction } from "../wagering/wager-transaction";
import { WagerTransactionStatus } from "../wagering/wager-transaction-status";
import type { EventContext } from "./event-context";
import { IntegrationEvent } from "./integration-event";
import { type WagerTransactionEventData, wagerTransactionEventData } from "./wager-transaction-event-data";

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balance: MoneyProps;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const { failureCode, observedBalance } = transaction;
    if (transaction.status !== WagerTransactionStatus.Rejected || !failureCode || !observedBalance) {
      throw new InvalidOperationError(`Transaction ${transaction.id} is not rejected`);
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...wagerTransactionEventData(transaction),
        failureCode,
        balance: observedBalance.toJSON(),
        rejectedAt: transaction.updatedAt.toISOString(),
      },
    });
  }
}
