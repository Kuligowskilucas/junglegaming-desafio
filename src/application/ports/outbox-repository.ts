import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface OutboxClaimLimits {
  orderingKeys: number;
  messagesPerOrderingKey: number;
}

export abstract class OutboxRepository {
  abstract add(message: OutboxMessage): Promise<void>;
  abstract claimDue(now: Date, limits: OutboxClaimLimits): Promise<OutboxMessage[]>;
  abstract save(message: OutboxMessage): Promise<void>;
}
