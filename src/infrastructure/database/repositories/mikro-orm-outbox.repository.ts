import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { type OutboxClaimLimits, OutboxRepository } from "../../../application/ports/outbox-repository";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { outboxMessageMapper } from "../mappers/outbox-message.mapper";
import { OutboxMessageRecord } from "../records/outbox-message.record";

interface OutboxDatabase {
  outbox_messages: {
    id: string;
    aggregate_id: string;
    ordering_key: string;
    position: string | number;
    event_type: string;
    payload: unknown;
    occurred_at: Date | string;
    attempts: number;
    next_attempt_at: Date | string | null;
    published_at: Date | string | null;
  };
}

type OutboxRow = OutboxDatabase["outbox_messages"];

@Injectable()
export class MikroOrmOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageRecord, outboxMessageMapper.toRecord(message));
  }

  async claimDue(now: Date, limits: OutboxClaimLimits): Promise<OutboxMessage[]> {
    const db = this.em.getKysely<OutboxDatabase>();
    const heads = await db
      .selectFrom("outbox_messages as head")
      .select("head.ordering_key")
      .where("head.published_at", "is", null)
      .where((eb) =>
        eb.or([
          eb.and([eb("head.next_attempt_at", "is", null), eb("head.occurred_at", "<=", now)]),
          eb("head.next_attempt_at", "<=", now),
        ]),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("outbox_messages as earlier")
              .select("earlier.id")
              .whereRef("earlier.ordering_key", "=", "head.ordering_key")
              .where("earlier.published_at", "is", null)
              .whereRef("earlier.position", "<", "head.position"),
          ),
        ),
      )
      .orderBy("head.position")
      .limit(limits.orderingKeys)
      .forUpdate()
      .skipLocked()
      .execute();
    if (heads.length === 0) {
      return [];
    }
    const pending = await db
      .selectFrom("outbox_messages")
      .selectAll()
      .where(
        "ordering_key",
        "in",
        heads.map((head) => head.ordering_key),
      )
      .where("published_at", "is", null)
      .orderBy("ordering_key")
      .orderBy("position")
      .forUpdate()
      .execute();
    const claimed: OutboxMessage[] = [];
    const takenPerKey = new Map<string, number>();
    const blockedKeys = new Set<string>();
    for (const row of pending) {
      const message = toPendingMessage(row);
      const taken = takenPerKey.get(message.orderingKey) ?? 0;
      if (blockedKeys.has(message.orderingKey) || taken >= limits.messagesPerOrderingKey || !message.isDue(now)) {
        blockedKeys.add(message.orderingKey);
        continue;
      }
      takenPerKey.set(message.orderingKey, taken + 1);
      claimed.push(message);
    }
    return claimed;
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }
}

function toPendingMessage(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    orderingKey: row.ordering_key,
    position: Number(row.position),
    eventType: row.event_type,
    payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
    occurredAt: new Date(row.occurred_at),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? undefined : new Date(row.next_attempt_at),
    publishedAt: undefined,
  });
}
