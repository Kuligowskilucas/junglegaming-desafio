import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { WagerTransactionConsumer } from "../../../src/interfaces/sqs/wager-transaction.consumer";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, resetDatabase, rowLockWaiters } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import {
  createTestQueues,
  deleteTestQueues,
  queueDepth,
  requestEnvelope,
  sendEnvelope,
  type TestQueues,
  testSqsClient,
  waitUntil,
} from "../../support/sqs";
import { WageringClient } from "../../support/wagering-client";

useIntegrationEnvironment();

describe("consumer shutdown", () => {
  let sql: SQL;
  let sqs: SQSClient;
  let queues: TestQueues;
  const apps: TestApp[] = [];

  const startApp = async (overrides: Record<string, string>) => {
    const testApp = await createTestApp({
      SQS_WAGER_QUEUE_NAME: queues.queueName,
      SQS_WAGER_DLQ_NAME: queues.deadLetterQueueName,
      SQS_RETRY_BASE_SECONDS: "1",
      SQS_RETRY_MAX_SECONDS: "1",
      ...overrides,
    });
    apps.push(testApp);
    return testApp;
  };


  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
    sqs = testSqsClient();
  });

  beforeEach(async () => {
    queues = await createTestQueues(sqs, { visibilityTimeoutSeconds: 30 });
  });

  afterEach(async () => {
    for (const testApp of apps.splice(0)) {
      await testApp.app.close();
    }
    await assertAllWalletsMatchLedger(sql);
    await deleteTestQueues(sqs, queues);
  });

  afterAll(async () => {
    await sql.close();
    sqs.destroy();
  });

  test("finishes the message in progress, hands the rest of the batch back and stops", async () => {
    const first = await startApp({ SQS_CONSUMER_ENABLED: "false", SQS_WAIT_TIME_SECONDS: "1" });
    const client = new WageringClient(first.baseUrl);
    const wallet = await client.openWallet("100.00");
    const inProgress = requestEnvelope(wallet, "BET", "10.00");
    const notStarted = requestEnvelope(wallet, "BET", "20.00");
    await sendEnvelope(sqs, queues.queueUrl, inProgress);
    await sendEnvelope(sqs, queues.queueUrl, notStarted);

    let closing: Promise<number> | undefined;
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      first.app.get(WagerTransactionConsumer).start();
      await waitUntil(async () => (await rowLockWaiters(sql)) > 0, { description: "the first message to wait for the wallet lock" });
      const startedClosingAt = Date.now();
      closing = first.app.close().then(() => Date.now() - startedClosingAt);
      apps.splice(apps.indexOf(first), 1);
      await Bun.sleep(300);
    });
    const closeTookMs = await closing!;

    expect(closeTookMs).toBeLessThan(10_000);
    const [{ count: handled }] = await sql`
      SELECT count(*)::int AS count FROM inbox_messages WHERE message_id IN (${inProgress.messageId}, ${notStarted.messageId})`;
    expect(handled).toBe(1);
    await waitUntil(async () => (await queueDepth(sqs, queues.queueUrl)).visible === 1, {
      description: "the unstarted message to be visible again right away",
      timeoutMs: 3_000,
    });

    const second = await startApp({ SQS_CONSUMER_ENABLED: "true", SQS_WAIT_TIME_SECONDS: "1" });
    await waitUntil(async () => (await new WageringClient(second.baseUrl).balanceOf(wallet.id)) === "70.00", {
      description: "the second instance to apply the handed back message",
    });
    await waitUntil(
      async () => {
        const depth = await queueDepth(sqs, queues.queueUrl);
        return depth.visible === 0 && depth.inFlight === 0;
      },
      { description: "the queue to be empty" },
    );
  });

  test("does not wait for the 20 s long poll to stop", async () => {
    const testApp = await startApp({ SQS_CONSUMER_ENABLED: "true", SQS_WAIT_TIME_SECONDS: "20" });
    await Bun.sleep(500);

    const startedClosingAt = Date.now();
    await testApp.app.close();
    apps.splice(apps.indexOf(testApp), 1);

    expect(Date.now() - startedClosingAt).toBeLessThan(2_000);
  });
});
