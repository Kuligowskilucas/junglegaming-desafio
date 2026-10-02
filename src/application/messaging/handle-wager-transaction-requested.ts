import { InboxMessage } from "../../domain/messaging/inbox-message";
import { DuplicateInboxMessageError, InboxPayloadMismatchError } from "../errors";
import type { Clock } from "../ports/clock";
import type { InboxRepository } from "../ports/inbox-repository";
import type { TransactionRunner } from "../ports/transaction-runner";
import type {
  SubmissionResult,
  SubmitWagerTransaction,
  WagerTransactionPayload,
} from "../wagering/submit-wager-transaction";

export interface WagerTransactionRequest {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  idempotencyKey: string;
  payload: WagerTransactionPayload;
  correlationId: string;
}

export type MessageHandlingResult =
  | { outcome: "HANDLED"; submission: SubmissionResult }
  | { outcome: "DUPLICATE" };

export class HandleWagerTransactionRequested {
  constructor(
    private readonly inbox: InboxRepository,
    private readonly submitWagerTransaction: SubmitWagerTransaction,
    private readonly transactionRunner: TransactionRunner,
    private readonly clock: Clock,
  ) {}

  async handle(request: WagerTransactionRequest): Promise<MessageHandlingResult> {
    try {
      return await this.transactionRunner.run(async () => {
        const receivedAt = this.clock.now();
        const message = InboxMessage.receive({
          messageId: request.messageId,
          consumerName: request.consumerName,
          payloadHash: request.payloadHash,
          receivedAt,
        });
        message.markProcessed(receivedAt);
        await this.inbox.add(message);
        const submission = await this.submitWagerTransaction.execute({
          idempotencyKey: request.idempotencyKey,
          payload: request.payload,
          correlationId: request.correlationId,
          causationId: request.messageId,
        });
        return { outcome: "HANDLED", submission };
      });
    } catch (error) {
      if (error instanceof DuplicateInboxMessageError) {
        const handled = await this.inbox.find(request.consumerName, request.messageId);
        if (handled && !handled.matchesPayload(request.payloadHash)) {
          throw new InboxPayloadMismatchError(request.consumerName, request.messageId);
        }
        return { outcome: "DUPLICATE" };
      }
      throw error;
    }
  }
}
