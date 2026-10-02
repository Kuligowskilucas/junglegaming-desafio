import { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { InboxMessageRecord } from "../records/inbox-message.record";

export const inboxMessageMapper = {
  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: record.messageId,
      consumerName: record.consumerName,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  },

  toRecord(message: InboxMessage): InboxMessageRecord {
    return {
      messageId: message.messageId,
      consumerName: message.consumerName,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    };
  },
};
