import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { AppProcess, logTails } from "../support/app-process";
import { connectSql, resetDatabase } from "../support/database";
import { useIntegrationEnvironment } from "../support/integration";
import { assertAllWalletsMatchLedger } from "../support/ledger-invariant";
import { discardPendingOutbox, idsByOrderingKey, outboxRows, pendingOutboxCount } from "../support/outbox";
import { SqsFaultProxy } from "../support/sqs-fault-proxy";
import {
  byGroup,
  createEventsQueue,
  createTestQueues,
  deleteEventsQueue,
  deleteTestQueues,
  type EventsQueue,
  queueDepth,
  type RequestEnvelope,
  requestEnvelope,
  receiveEvents,
  sendEnvelope,
  type TestQueues,
  testSqsClient,
  waitUntil,
} from "../support/sqs";
import { wager, WageringClient, type WalletHandle } from "../support/wagering-client";

useIntegrationEnvironment({ testTimeoutMs: 120_000 });

describe("messaging across application processes", () => {
  let sql: SQL;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: EventsQueue;
  let proxy: SqsFaultProxy | undefined;

  const consumerEnvironment = () => ({
    SQS_CONSUMER_ENABLED: "true",
    SQS_WAGER_QUEUE_NAME: queues.queueName,
    SQS_WAGER_DLQ_NAME: queues.deadLetterQueueName,
    SQS_EVENTS_QUEUE_NAME: events.queueName,
  });

  const publisherEnvironment = (overrides: Record<string, string> = {}) => ({
    OUTBOX_PUBLISHER_ENABLED: "true",
    SQS_EVENTS_QUEUE_NAME: events.queueName,
    ...overrides,
  });

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
    sqs = testSqsClient();
  });

  beforeEach(async () => {
    await discardPendingOutbox(sql);
    queues = await createTestQueues(sqs, { visibilityTimeoutSeconds: 2, maxReceiveCount: 10 });
    events = await createEventsQueue(sqs);
  });

  afterEach(async () => {
    await AppProcess.stopAll();
    proxy?.stop();
    proxy = undefined;
    await assertAllWalletsMatchLedger(sql);
    await deleteTestQueues(sqs, queues);
    await deleteEventsQueue(sqs, events);
  });

  afterAll(async () => {
    await sql.close();
    sqs.destroy();
  });

  test("consumers in three processes apply every message once, duplicates included", async () => {
    const consumers = await AppProcess.startMany(3, "consumer", consumerEnvironment());
    const client = new WageringClient(consumers[0]!.baseUrl);
    const wallets: WalletHandle[] = await Promise.all(Array.from({ length: 30 }, () => client.openWallet("1000.00")));
    const envelopes = wallets.flatMap((wallet) => Array.from({ length: 4 }, () => requestEnvelope(wallet, "BET", "1.00")));
    const redelivered = envelopes.filter((_, index) => index % 8 === 0);
    const sameKeyNewMessage: RequestEnvelope[] = envelopes
      .filter((_, index) => index % 8 === 4)
      .map((envelope) => ({ ...envelope, messageId: `msg-${Bun.randomUUIDv7()}` }));

    await Promise.all(envelopes.map((envelope) => sendEnvelope(sqs, queues.queueUrl, envelope)));
    await Promise.all([
      ...redelivered.map((envelope) => sendEnvelope(sqs, queues.queueUrl, envelope, { deduplicationId: Bun.randomUUIDv7() })),
      ...sameKeyNewMessage.map((envelope) => sendEnvelope(sqs, queues.queueUrl, envelope)),
    ]);
    const messageIds = [...envelopes, ...sameKeyNewMessage].map((envelope) => envelope.messageId);
    await waitUntil(
      async () => {
        const [{ count }] = await sql`SELECT count(*)::int AS count FROM inbox_messages WHERE message_id IN ${sql(messageIds)}`;
        const depth = await queueDepth(sqs, queues.queueUrl);
        return count === messageIds.length && depth.visible === 0 && depth.inFlight === 0;
      },
      { description: "every message to be handled", timeoutMs: 60_000 },
    ).catch(async (error) => {
      throw new Error(`${error}\n${await logTails(consumers)}`);
    });

    for (const wallet of wallets) {
      expect(await client.balanceOf(wallet.id)).toBe("996.00");
    }
    expect(await queueDepth(sqs, queues.deadLetterQueueUrl)).toEqual({ visible: 0, inFlight: 0 });
    const metrics = await Promise.all(consumers.map((consumer) => consumer.metrics()));
    const processed = metrics.map((snapshot) =>
      snapshot.sum("wagering_transactions_total", { source: "sqs", kind: "BET", status: "PROCESSED" }),
    );
    expect(sum(processed)).toBe(envelopes.length);
    expect(sum(metrics.map((snapshot) => snapshot.sum("wagering_duplicates_total", { source: "sqs", type: "inbox" })))).toBe(
      redelivered.length,
    );
    expect(
      sum(metrics.map((snapshot) => snapshot.sum("wagering_duplicates_total", { source: "sqs", type: "idempotent_replay" }))),
    ).toBe(sameKeyNewMessage.length);
    expect(processed.filter((count) => count > 0).length).toBeGreaterThanOrEqual(2);
  });

  test("publishers in two processes publish every event once and in the order of each wallet", async () => {
    const publishers = await AppProcess.startMany(
      2,
      "publisher",
      publisherEnvironment({ OUTBOX_BATCH_WALLETS: "5", OUTBOX_BATCH_EVENTS_PER_WALLET: "2" }),
    );
    const producer = await AppProcess.start("producer");
    const client = WageringClient.retrying(producer.baseUrl);

    const wallets = await Promise.all(
      Array.from({ length: 25 }, async () => {
        const wallet = await client.openWallet("100.00");
        for (let bet = 0; bet < 2; bet += 1) {
          expect((await client.submitWager(wager(wallet, "BET", "1.00"))).status).toBe(200);
        }
        return wallet;
      }),
    );
    const expected = await outboxRows(sql, { orderingKeys: wallets.map((wallet) => wallet.id) });
    expect(expected).toHaveLength(150);
    await waitUntil(async () => (await pendingOutboxCount(sql)) === 0, {
      description: "every event to be published",
      timeoutMs: 30_000,
    });

    const received = await receiveEvents(sqs, events.queueUrl, expected.length);
    expect(received).toHaveLength(expected.length);
    expect(new Set(received.map((event) => event.eventId))).toEqual(new Set(expected.map((row) => row.id)));
    const expectedOrder = idsByOrderingKey(expected);
    const receivedOrder = byGroup(received);
    for (const wallet of wallets) {
      expect(receivedOrder.get(wallet.id)).toEqual(expectedOrder.get(wallet.id)!);
    }
    const published = await Promise.all(
      publishers.map(async (publisher) => (await publisher.metrics()).sum("wagering_outbox_publication_delay_seconds_count")),
    );
    console.info(`[multiprocess] events published per publisher process: ${published.join(" + ")}`);
    expect(sum(published)).toBe(expected.length);
    expect(published.every((count) => count > 0)).toBe(true);
  });

  test("a publisher killed after the queue accepted an event and before marking it is replaced without a duplicate", async () => {
    proxy = new SqsFaultProxy();
    const accepted = proxy.holdAfterForwarding("SendMessage", (body) => String(body.QueueUrl).endsWith(events.queueName));
    const producer = await AppProcess.start("producer");
    const doomed = await AppProcess.start("doomed-publisher", publisherEnvironment({ SQS_ENDPOINT: proxy.endpoint }));
    const client = new WageringClient(producer.baseUrl);
    const wallet = await client.openWallet("100.00");
    expect((await client.submitWager(wager(wallet, "BET", "10.00"))).status).toBe(200);

    const sentButUnmarked = await accepted;
    await doomed.kill();
    const rows = await outboxRows(sql, { orderingKeys: [wallet.id] });
    expect(rows.map((row) => row.publishedAt)).toEqual(rows.map(() => null));
    expect(JSON.parse(String(sentButUnmarked.MessageBody)).eventId).toBe(rows[0]!.id);

    const survivor = await AppProcess.start("survivor-publisher", publisherEnvironment());
    await waitUntil(async () => (await outboxRows(sql, { orderingKeys: [wallet.id] })).every((row) => row.publishedAt !== null), {
      description: "the survivor to publish every event",
    });

    const received = await receiveEvents(sqs, events.queueUrl, rows.length);
    expect(received.map((event) => event.eventId)).toEqual(rows.map((row) => row.id));
    expect((await survivor.metrics()).sum("wagering_outbox_publication_delay_seconds_count")).toBe(rows.length);
  });
});
