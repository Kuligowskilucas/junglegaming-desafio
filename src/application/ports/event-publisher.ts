import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export abstract class EventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
}
