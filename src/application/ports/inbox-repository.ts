import type { InboxMessage } from "../../domain/messaging/inbox-message";

export abstract class InboxRepository {
  abstract add(message: InboxMessage): Promise<void>;
  abstract find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}
