import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { EventPublisher } from "../../../src/application/ports/event-publisher";
import type { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { outboxRetryPolicy } from "../../../src/domain/messaging/outbox-message";
import { backoffDelayMs } from "../../../src/domain/shared/retry-backoff";
import { OutboxPublisherWorker } from "../../../src/interfaces/workers/outbox-publisher.worker";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import { discardPendingOutbox, idsByOrderingKey, outboxRows, pendingOutboxCount } from "../../support/outbox";
import {
  byGroup,
  createEventsQueue,
  deleteEventsQueue,
  type EventsQueue,
  eventsQueueName,
  receiveEvents,
  testSqsClient,
  waitUntil,
} from "../../support/sqs";
import { wager, WageringClient, type WalletHandle } from "../../support/wagering-client";

useIntegrationEnvironment();

describe("outbox publisher", () => {
  let sql: SQL;
  let sqs: SQSClient;
  let queue: EventsQueue;
  const apps: TestApp[] = [];
  const publicationsByScenario = new Map<string, string>();

  const startApp = async (overrides: Record<string, string> = {}) => {
    const testApp = await createTestApp({
      SQS_EVENTS_QUEUE_NAME: queue.queueName,
      OUTBOX_POLL_INTERVAL_MS: "100",
      ...overrides,
    });
    apps.push(testApp);
    return testApp;
  };

  const closeApp = async (testApp: TestApp) => {
    apps.splice(apps.indexOf(testApp), 1);
    await testApp.app.close();
  };

  const startPublisher = (testApp: TestApp) => testApp.app.get(OutboxPublisherWorker).start();

  const countPublications = (testApp: TestApp) => {
    const publisher = testApp.app.get(EventPublisher);
    const publish = publisher.publish.bind(publisher);
    const counter = { sent: 0 };
    publisher.publish = async (message: OutboxMessage) => {
      counter.sent += 1;
      await publish(message);
    };
    return counter;
  };

  const seedWallets = async (client: WageringClient, wallets: number, betsPerWallet: number) => {
    const handles = await Promise.all(Array.from({ length: wallets }, () => client.openWallet("100.00")));
    await Promise.all(
      handles.map(async (wallet) => {
        for (let bet = 0; bet < betsPerWallet; bet += 1) {
          expect((await client.submitWager(wager(wallet, "BET", "1.00"))).status).toBe(200);
        }
      }),
    );
    return handles;
  };

  const rowsOf = (...wallets: WalletHandle[]) => outboxRows(sql, { orderingKeys: wallets.map((wallet) => wallet.id) });

  const waitForEmptyOutbox = () =>
    waitUntil(async () => (await pendingOutboxCount(sql)) === 0, {
      description: "every outbox event to be published",
      timeoutMs: 20_000,
    });

  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
    sqs = testSqsClient();
  });

  beforeEach(async () => {
    await discardPendingOutbox(sql);
    queue = await createEventsQueue(sqs);
  });

  afterEach(async () => {
    for (const testApp of apps.splice(0)) {
      await testApp.app.close();
    }
    await assertAllWalletsMatchLedger(sql);
    await deleteEventsQueue(sqs, queue);
  });

  afterAll(async () => {
    console.info(
      `[outbox publisher] publications per scenario:\n${[...publicationsByScenario]
        .map(([name, summary]) => `  ${name}: ${summary}`)
        .join("\n")}`,
    );
    await sql.close();
    sqs.destroy();
  });

  test("two publishers deliver every event exactly once and in the order of each wallet", async () => {
    const seeder = await startApp();
    const wallets = await seedWallets(new WageringClient(seeder.baseUrl), 25, 2);
    const expected = await rowsOf(...wallets);
    expect(expected).toHaveLength(150);

    const limits = { OUTBOX_BATCH_WALLETS: "5", OUTBOX_BATCH_EVENTS_PER_WALLET: "2" };
    const publishers = [await startApp(limits), await startApp(limits)];
    const counters = publishers.map(countPublications);
    publishers.forEach(startPublisher);

    await waitForEmptyOutbox();
    const received = await receiveEvents(sqs, queue.queueUrl, expected.length);
    const duplicates = received.length - new Set(received.map((event) => event.eventId)).size;
    publicationsByScenario.set(
      "two publishers",
      `sent ${counters.map((counter) => counter.sent).join(" + ")}, received ${received.length}, duplicates ${duplicates}`,
    );

    expect(counters.every((counter) => counter.sent > 0)).toBe(true);
    expect(counters.reduce((total, counter) => total + counter.sent, 0)).toBe(expected.length);
    expect(duplicates).toBe(0);
    expect(new Set(received.map((event) => event.eventId))).toEqual(new Set(expected.map((row) => row.id)));
    const expectedOrder = idsByOrderingKey(expected);
    const receivedOrder = byGroup(received);
    for (const wallet of wallets) {
      expect(receivedOrder.get(wallet.id)).toEqual(expectedOrder.get(wallet.id)!);
    }
    const sample = received[0]!;
    const sampleRow = expected.find((row) => row.id === sample.eventId)!;
    expect(sample).toMatchObject({
      eventType: sampleRow.eventType,
      groupId: sampleRow.orderingKey,
      deduplicationId: sampleRow.id,
      body: sampleRow.payload,
      attributes: {
        eventId: sampleRow.id,
        eventType: sampleRow.eventType,
        aggregateId: sampleRow.aggregateId,
        correlationId: sampleRow.payload.correlationId as string,
        version: "1",
      },
    });
  });

  test("an event committed by an instance that died before publishing is published by another instance", async () => {
    const dead = await startApp();
    const client = new WageringClient(dead.baseUrl);
    const wallet = await client.openWallet("50.00");
    expect((await client.submitWager(wager(wallet, "BET", "5.00"))).status).toBe(200);
    await closeApp(dead);
    const pending = await rowsOf(wallet);
    expect(pending.map((row) => row.publishedAt)).toEqual([null, null, null, null]);

    await startApp({ OUTBOX_PUBLISHER_ENABLED: "true" });

    const received = await receiveEvents(sqs, queue.queueUrl, pending.length);
    expect(received.map((event) => event.eventId)).toEqual(pending.map((row) => row.id));
    expect((await rowsOf(wallet)).every((row) => row.publishedAt !== null)).toBe(true);
  });

  test("an event sent but not marked as published is sent again and the queue absorbs the duplicate", async () => {
    const testApp = await startApp();
    const client = new WageringClient(testApp.baseUrl);
    const wallet = await client.openWallet("50.00");
    expect((await client.submitWager(wager(wallet, "BET", "5.00"))).status).toBe(200);
    const rows = await rowsOf(wallet);
    const counter = countPublications(testApp);

    await sql.unsafe(`
      CREATE FUNCTION test_crash_before_marking() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'simulated crash after sending and before marking as published';
      END
      $$;
      CREATE TRIGGER test_crash_before_marking BEFORE UPDATE ON outbox_messages FOR EACH ROW
        WHEN (NEW.published_at IS NOT NULL) EXECUTE FUNCTION test_crash_before_marking();
    `);
    try {
      startPublisher(testApp);
      await waitUntil(async () => counter.sent >= rows.length * 3, { description: "three publication cycles" });
      const rolledBack = await rowsOf(wallet);
      expect(rolledBack.map((row) => [row.publishedAt, row.attempts])).toEqual(rows.map(() => [null, 0]));
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS test_crash_before_marking ON outbox_messages;
        DROP FUNCTION IF EXISTS test_crash_before_marking();
      `);
    }

    await waitForEmptyOutbox();
    const received = await receiveEvents(sqs, queue.queueUrl, rows.length);
    publicationsByScenario.set("sent but not marked", `sent ${counter.sent}, received ${received.length}`);

    expect(counter.sent).toBeGreaterThan(rows.length);
    expect(received.map((event) => event.eventId)).toEqual(rows.map((row) => row.id));
  });

  test("a failed publication is retried with backoff and delivered once the queue exists", async () => {
    const missingQueueName = eventsQueueName();
    const testApp = await startApp({ SQS_EVENTS_QUEUE_NAME: missingQueueName, OUTBOX_PUBLISHER_ENABLED: "true" });
    const client = new WageringClient(testApp.baseUrl);
    const wallet = await client.openWallet("50.00");
    expect((await client.submitWager(wager(wallet, "BET", "5.00"))).status).toBe(200);

    await waitUntil(async () => (await rowsOf(wallet))[0]!.attempts >= 1, { description: "a failed attempt" });
    const [head, ...following] = await rowsOf(wallet);
    expect(head!.publishedAt).toBeNull();
    expect(head!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(
      Date.now() + backoffDelayMs(outboxRetryPolicy, head!.attempts) + 1_000,
    );
    expect(following.map((row) => [row.attempts, row.publishedAt])).toEqual(following.map(() => [0, null]));

    const created = await createEventsQueue(sqs, missingQueueName);
    try {
      await waitForEmptyOutbox();
      const received = await receiveEvents(sqs, created.queueUrl, following.length + 1);
      expect(received.map((event) => event.eventId)).toEqual([head!, ...following].map((row) => row.id));
    } finally {
      await deleteEventsQueue(sqs, created);
    }
  });

  test("an event in backoff holds back the following events of its wallet but not other wallets", async () => {
    const testApp = await startApp();
    const client = new WageringClient(testApp.baseUrl);
    const [blocked, free] = await seedWallets(client, 2, 1);
    const blockedRows = await rowsOf(blocked!);
    const freeRows = await rowsOf(free!);
    const inBackoff = blockedRows[1]!;
    await sql`UPDATE outbox_messages SET attempts = 1, next_attempt_at = now() + interval '1 hour' WHERE id = ${inBackoff.id}`;

    startPublisher(testApp);
    await waitUntil(
      async () =>
        (await rowsOf(free!)).every((row) => row.publishedAt !== null) &&
        (await rowsOf(blocked!))[0]!.publishedAt !== null,
      { description: "the free wallet and the head of the blocked one" },
    );
    await Bun.sleep(500);
    expect((await rowsOf(blocked!)).map((row) => row.publishedAt !== null)).toEqual([true, false, false, false]);

    await sql`UPDATE outbox_messages SET next_attempt_at = now() WHERE id = ${inBackoff.id}`;
    await waitForEmptyOutbox();

    const received = byGroup(await receiveEvents(sqs, queue.queueUrl, blockedRows.length + freeRows.length));
    expect(received.get(blocked!.id)).toEqual(blockedRows.map((row) => row.id));
    expect(received.get(free!.id)).toEqual(freeRows.map((row) => row.id));
  });
});
