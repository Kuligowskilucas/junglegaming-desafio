import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { AppProcess } from "../support/app-process";
import { connectSql, resetDatabase, rowLockWaiters } from "../support/database";
import { useIntegrationEnvironment } from "../support/integration";
import { assertAllWalletsMatchLedger } from "../support/ledger-invariant";
import { discardPendingOutbox, outboxRows } from "../support/outbox";
import { SqsFaultProxy } from "../support/sqs-fault-proxy";
import {
  createEventsQueue,
  createTestQueues,
  deleteEventsQueue,
  deleteTestQueues,
  type EventsQueue,
  queueDepth,
  type RequestEnvelope,
  receiveEvents,
  requestEnvelope,
  sendEnvelope,
  type TestQueues,
  testSqsClient,
  waitUntil,
} from "../support/sqs";
import { WageringClient, type WalletHandle } from "../support/wagering-client";

useIntegrationEnvironment({ testTimeoutMs: 120_000 });

describe("application processes that die or stop", () => {
  let sql: SQL;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: EventsQueue;
  let proxy: SqsFaultProxy | undefined;

  const consumerEnvironment = (overrides: Record<string, string> = {}) => ({
    SQS_CONSUMER_ENABLED: "true",
    SQS_WAGER_QUEUE_NAME: queues.queueName,
    SQS_WAGER_DLQ_NAME: queues.deadLetterQueueName,
    SQS_EVENTS_QUEUE_NAME: events.queueName,
    ...overrides,
  });

  const inboxRows = async (messageId: string) =>
    (await sql`SELECT count(*)::int AS count FROM inbox_messages WHERE message_id = ${messageId}`)[0].count as number;

  const ledgerEntriesOf = async (envelope: RequestEnvelope) =>
    (
      await sql`
        SELECT count(*)::int AS count FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
         WHERE t.provider_id = ${envelope.data.providerId as string}
           AND t.external_transaction_id = ${envelope.data.externalTransactionId}`
    )[0].count as number;

  const waitForEmptyQueue = () =>
    waitUntil(
      async () => {
        const depth = await queueDepth(sqs, queues.queueUrl);
        return depth.visible === 0 && depth.inFlight === 0;
      },
      { description: "the queue to be empty", timeoutMs: 30_000 },
    );

  const openWallet = async (amount = "100.00"): Promise<{ wallet: WalletHandle; helper: AppProcess }> => {
    const helper = await AppProcess.start("helper");
    return { wallet: await new WageringClient(helper.baseUrl).openWallet(amount), helper };
  };

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

  test("a process killed after the commit and before the ack is absorbed by the inbox of another process", async () => {
    proxy = new SqsFaultProxy();
    const ackHeld = proxy.holdBeforeForwarding("DeleteMessage", (body) => String(body.QueueUrl).endsWith(queues.queueName));
    const { wallet, helper } = await openWallet();
    const doomed = await AppProcess.start("doomed-consumer", consumerEnvironment({ SQS_ENDPOINT: proxy.endpoint }));
    const envelope = requestEnvelope(wallet, "BET", "10.00");

    await sendEnvelope(sqs, queues.queueUrl, envelope);
    await ackHeld;
    expect(await inboxRows(envelope.messageId)).toBe(1);
    expect(await queueDepth(sqs, queues.queueUrl)).toEqual({ visible: 0, inFlight: 1 });
    await doomed.kill();

    const survivor = await AppProcess.start(
      "survivor-consumer",
      consumerEnvironment({ OUTBOX_PUBLISHER_ENABLED: "true" }),
    );
    await waitForEmptyQueue();
    await waitUntil(async () => (await outboxRows(sql, { orderingKeys: [wallet.id] })).every((row) => row.publishedAt !== null), {
      description: "the events to be published",
    });

    expect(await inboxRows(envelope.messageId)).toBe(1);
    expect(await ledgerEntriesOf(envelope)).toBe(1);
    expect(await new WageringClient(helper.baseUrl).balanceOf(wallet.id)).toBe("90.00");
    const survivorMetrics = await survivor.metrics();
    expect(survivorMetrics.sum("wagering_duplicates_total", { source: "sqs", type: "inbox" })).toBe(1);
    expect(survivorMetrics.sum("wagering_transactions_total", { source: "sqs" })).toBe(0);
    const rows = await outboxRows(sql, { orderingKeys: [wallet.id] });
    const received = await receiveEvents(sqs, events.queueUrl, rows.length);
    expect(received.map((event) => event.eventId)).toEqual(rows.map((row) => row.id));
  });

  test("a process killed before the commit leaves nothing behind and another process applies the message once", async () => {
    const { wallet, helper } = await openWallet();
    const envelope = requestEnvelope(wallet, "BET", "10.00");
    let doomed: AppProcess | undefined;

    await sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      doomed = await AppProcess.start("doomed-consumer", consumerEnvironment({ DB_LOCK_TIMEOUT_MS: "10000" }));
      await sendEnvelope(sqs, queues.queueUrl, envelope);
      await waitUntil(async () => (await rowLockWaiters(sql)) > 0, { description: "the consumer to wait for the wallet lock" });
      await doomed.kill();
      expect(await inboxRows(envelope.messageId)).toBe(0);
    });

    const survivor = await AppProcess.start("survivor-consumer", consumerEnvironment());
    await waitForEmptyQueue();

    expect(await inboxRows(envelope.messageId)).toBe(1);
    expect(await ledgerEntriesOf(envelope)).toBe(1);
    expect(await new WageringClient(helper.baseUrl).balanceOf(wallet.id)).toBe("90.00");
    expect((await survivor.metrics()).sum("wagering_transactions_total", { source: "sqs", kind: "BET", status: "PROCESSED" })).toBe(
      1,
    );
  });

  test("SIGTERM finishes the message in progress, hands back the rest of the batch and exits", async () => {
    const { wallet, helper } = await openWallet();
    const inProgress = requestEnvelope(wallet, "BET", "10.00");
    const notStarted = requestEnvelope(wallet, "BET", "20.00");
    let stopping: Promise<{ signal: string | null; tookMs: number }> | undefined;
    let doomed: AppProcess | undefined;

    await sendEnvelope(sqs, queues.queueUrl, inProgress);
    await sendEnvelope(sqs, queues.queueUrl, notStarted);
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      doomed = await AppProcess.start("doomed-consumer", consumerEnvironment({ DB_LOCK_TIMEOUT_MS: "10000" }));
      await waitUntil(async () => (await rowLockWaiters(sql)) > 0, { description: "the first message to wait for the wallet lock" });
      const startedAt = Date.now();
      stopping = doomed.terminate().then((exit) => ({ signal: exit.signal, tookMs: Date.now() - startedAt }));
      await Bun.sleep(500);
    });
    const stopped = await stopping!;

    expect(stopped.signal).toBe("SIGTERM");
    expect(stopped.tookMs).toBeLessThan(10_000);
    const messages = (await doomed!.logLines()).map((line) => line.message);
    expect(messages).toContain("SQS consumer stopped");
    expect(messages).not.toContain("Shutdown grace elapsed with messages still in progress; unfinished ones roll back and are redelivered");
    expect(await inboxRows(inProgress.messageId)).toBe(1);
    expect(await inboxRows(notStarted.messageId)).toBe(0);
    await waitUntil(async () => (await queueDepth(sqs, queues.queueUrl)).visible === 1, {
      description: "the unstarted message to be visible again right away",
      timeoutMs: 1_500,
    });

    await AppProcess.start("survivor-consumer", consumerEnvironment());
    await waitForEmptyQueue();

    expect(await inboxRows(notStarted.messageId)).toBe(1);
    expect(await ledgerEntriesOf(inProgress)).toBe(1);
    expect(await ledgerEntriesOf(notStarted)).toBe(1);
    expect(await new WageringClient(helper.baseUrl).balanceOf(wallet.id)).toBe("70.00");
  });
});
