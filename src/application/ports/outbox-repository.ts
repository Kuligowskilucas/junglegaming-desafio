import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export abstract class OutboxRepository {
  abstract add(message: OutboxMessage): Promise<void>;
}
