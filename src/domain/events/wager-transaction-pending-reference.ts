import { InvalidOperationError } from "../shared/domain-error";
import type { WagerTransaction } from "../wagering/wager-transaction";
import { WagerTransactionStatus } from "../wagering/wager-transaction-status";
import type { EventContext } from "./event-context";
import { IntegrationEvent } from "./integration-event";
import { type WagerTransactionEventData, wagerTransactionEventData } from "./wager-transaction-event-data";

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  referenceAttempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    const { referenceExternalTransactionId, nextReferenceAttemptAt } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined ||
      nextReferenceAttemptAt === undefined
    ) {
      throw new InvalidOperationError(`Transaction ${transaction.id} is not waiting for its reference`);
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...wagerTransactionEventData(transaction),
        referenceExternalTransactionId,
        referenceAttempts: transaction.referenceAttempts,
        nextAttemptAt: nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}
