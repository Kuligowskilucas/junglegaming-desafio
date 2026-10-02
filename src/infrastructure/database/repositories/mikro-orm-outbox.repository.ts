import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { OutboxRepository } from "../../../application/ports/outbox-repository";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { outboxMessageMapper } from "../mappers/outbox-message.mapper";
import { OutboxMessageRecord } from "../records/outbox-message.record";

@Injectable()
export class MikroOrmOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageRecord, outboxMessageMapper.toRecord(message));
  }
}
