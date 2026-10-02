import type { SQL } from "bun";

export interface OutboxRow {
  id: string;
  orderingKey: string;
  eventType: string;
  aggregateId: string;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  payload: Record<string, unknown>;
}

export async function discardPendingOutbox(sql: SQL): Promise<void> {
  await sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`;
}

export async function outboxRows(sql: SQL, where: { orderingKeys: string[] } | { transactionId: string }): Promise<OutboxRow[]> {
  const rows: Record<string, unknown>[] =
    "transactionId" in where
      ? await sql`
          SELECT id::text, ordering_key, event_type, aggregate_id::text, attempts, next_attempt_at, published_at, payload
            FROM outbox_messages
           WHERE aggregate_id = ${where.transactionId} OR payload->'data'->>'transactionId' = ${where.transactionId}
           ORDER BY position`
      : await sql`
          SELECT id::text, ordering_key, event_type, aggregate_id::text, attempts, next_attempt_at, published_at, payload
            FROM outbox_messages WHERE ordering_key IN ${sql(where.orderingKeys)} ORDER BY position`;
  return rows.map((row) => ({
    id: row.id as string,
    orderingKey: row.ordering_key as string,
    eventType: row.event_type as string,
    aggregateId: row.aggregate_id as string,
    attempts: Number(row.attempts),
    nextAttemptAt: (row.next_attempt_at as Date | null) ?? null,
    publishedAt: (row.published_at as Date | null) ?? null,
    payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
  }));
}

export async function pendingOutboxCount(sql: SQL): Promise<number> {
  const [row] = await sql`SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NULL`;
  return row.count as number;
}

export function idsByOrderingKey(rows: OutboxRow[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    groups.set(row.orderingKey, [...(groups.get(row.orderingKey) ?? []), row.id]);
  }
  return groups;
}
