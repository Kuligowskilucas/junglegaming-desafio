import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import { WagerTransactionRecord } from "./records/wager-transaction.record";

export interface OutboxBacklog {
  pending: number;
  oldestOccurredAt: Date | undefined;
}

interface OutboxBacklogDatabase {
  outbox_messages: {
    occurred_at: Date;
    published_at: Date | null;
  };
}

@Injectable()
export class BacklogProbe {
  constructor(private readonly orm: MikroORM) {}

  async outbox(): Promise<OutboxBacklog> {
    const row = await this.orm.em
      .fork()
      .getKysely<OutboxBacklogDatabase>()
      .selectFrom("outbox_messages")
      .select((eb) => [eb.fn.countAll<string>().as("pending"), eb.fn.min("occurred_at").as("oldest")])
      .where("published_at", "is", null)
      .executeTakeFirstOrThrow();
    return {
      pending: Number(row.pending),
      oldestOccurredAt: row.oldest === null ? undefined : new Date(row.oldest),
    };
  }

  pendingReferences(): Promise<number> {
    return this.orm.em.fork().count(WagerTransactionRecord, { status: WagerTransactionStatus.PendingReference });
  }
}
