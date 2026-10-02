import { Injectable } from "@nestjs/common";
import { EventPublisher } from "../../application/ports/event-publisher";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { AppConfig } from "../config/app-config";
import { SqsQueueGateway } from "./sqs-queue-gateway";

@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly gateway: SqsQueueGateway,
    private readonly config: AppConfig,
  ) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.gateway.send(
      this.config.sqs.eventsQueueName,
      {
        body: JSON.stringify(message.payload),
        groupId: message.orderingKey,
        deduplicationId: message.id,
        attributes: envelopeAttributes(message),
      },
      AbortSignal.timeout(this.config.outbox.publishTimeoutMs),
    );
  }
}

function envelopeAttributes(message: OutboxMessage): Record<string, string> {
  const attributes: Record<string, string> = {
    eventType: message.eventType,
    eventId: message.id,
    aggregateId: message.aggregateId,
  };
  const { correlationId, version } = message.payload;
  if (typeof correlationId === "string") {
    attributes.correlationId = correlationId;
  }
  if (typeof version === "number") {
    attributes.version = String(version);
  }
  return attributes;
}
