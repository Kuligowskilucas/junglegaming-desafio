import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import type { OutboxMessageRecord } from "../records/outbox-message.record";

export const outboxMessageMapper = {
  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      orderingKey: record.orderingKey,
      position: record.position ?? undefined,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
      publishedAt: record.publishedAt ?? undefined,
    });
  },

  toRecord(message: OutboxMessage): Omit<OutboxMessageRecord, "position"> {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      orderingKey: message.orderingKey,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
    };
  },
};
