import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Clock } from "../ports/clock";
import type { EventPublisher } from "../ports/event-publisher";
import type { OutboxClaimLimits, OutboxRepository } from "../ports/outbox-repository";
import type { TransactionRunner } from "../ports/transaction-runner";

export interface PublicationFailure {
  eventId: string;
  orderingKey: string;
  error: unknown;
}

export interface PublicationReport {
  claimed: number;
  published: number;
  failures: PublicationFailure[];
}

export class PublishPendingEvents {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly transactionRunner: TransactionRunner,
    private readonly clock: Clock,
    private readonly limits: OutboxClaimLimits,
  ) {}

  runOnce(): Promise<PublicationReport> {
    return this.transactionRunner.run(async () => {
      const claimed = await this.outbox.claimDue(this.clock.now(), this.limits);
      const sequences = [...groupByOrderingKey(claimed).values()];
      const results = await Promise.all(sequences.map((sequence) => this.publishInOrder(sequence)));
      const failures = results.flatMap((result) => (result.failure ? [result.failure] : []));
      for (const message of results.flatMap((result) => result.touched)) {
        await this.outbox.save(message);
      }
      return {
        claimed: claimed.length,
        published: results.reduce((total, result) => total + result.published, 0),
        failures,
      };
    });
  }

  private async publishInOrder(
    sequence: OutboxMessage[],
  ): Promise<{ touched: OutboxMessage[]; published: number; failure: PublicationFailure | undefined }> {
    const touched: OutboxMessage[] = [];
    for (const message of sequence) {
      try {
        await this.publisher.publish(message);
        message.markPublished(this.clock.now());
        touched.push(message);
      } catch (error) {
        message.scheduleRetry(this.clock.now());
        touched.push(message);
        return {
          touched,
          published: touched.length - 1,
          failure: { eventId: message.id, orderingKey: message.orderingKey, error },
        };
      }
    }
    return { touched, published: touched.length, failure: undefined };
  }
}

function groupByOrderingKey(messages: OutboxMessage[]): Map<string, OutboxMessage[]> {
  const sequences = new Map<string, OutboxMessage[]>();
  for (const message of messages) {
    sequences.set(message.orderingKey, [...(sequences.get(message.orderingKey) ?? []), message]);
  }
  return sequences;
}
