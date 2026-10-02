import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { DuplicateInboxMessageError } from "../../../application/errors";
import { InboxRepository } from "../../../application/ports/inbox-repository";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import { isUniqueViolationOf } from "../constraint-violation";
import { inboxMessageMapper } from "../mappers/inbox-message.mapper";
import { InboxMessageRecord } from "../records/inbox-message.record";

@Injectable()
export class MikroOrmInboxRepository extends InboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(message: InboxMessage): Promise<void> {
    try {
      await this.em.insert(InboxMessageRecord, inboxMessageMapper.toRecord(message));
    } catch (error) {
      if (isUniqueViolationOf(error, "inbox_messages_pkey")) {
        throw new DuplicateInboxMessageError(message.consumerName, message.messageId);
      }
      throw error;
    }
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, { refresh: true });
    return record ? inboxMessageMapper.toDomain(record) : undefined;
  }
}
