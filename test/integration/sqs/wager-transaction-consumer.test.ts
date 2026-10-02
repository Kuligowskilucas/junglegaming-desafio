import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ChangeMessageVisibilityCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { HandleWagerTransactionRequested } from "../../../src/application/messaging/handle-wager-transaction-requested";
import { WagerTransactionConsumer } from "../../../src/interfaces/sqs/wager-transaction.consumer";
import {
  parseWagerTransactionMessage,
  toWagerTransactionRequest,
} from "../../../src/interfaces/sqs/wager-transaction-message";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, resetDatabase, rowLockWaiters } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import {
  createTestQueues,
  deleteTestQueues,
  drainDeadLetters,
  queueDepth,
  type RequestEnvelope,
  requestEnvelope,
  sendEnvelope,
  sendRaw,
  type TestQueues,
  testSqsClient,
  waitUntil,
} from "../../support/sqs";
import { WageringClient } from "../../support/wagering-client";

useIntegrationEnvironment();

describe("SQS consumer of wager transactions", () => {
  let sql: SQL;
  let sqs: SQSClient;
  let queues: TestQueues;
  let testApp: TestApp | undefined;
  let client: WageringClient;

  const startApp = async (overrides: Record<string, string> = {}) => {
    testApp = await createTestApp({
      SQS_CONSUMER_ENABLED: "true",
      SQS_WAGER_QUEUE_NAME: queues.queueName,
      SQS_WAGER_DLQ_NAME: queues.deadLetterQueueName,
      SQS_WAIT_TIME_SECONDS: "1",
      SQS_RETRY_BASE_SECONDS: "1",
      SQS_RETRY_MAX_SECONDS: "1",
      ...overrides,
    });
    client = new WageringClient(testApp.baseUrl);
    return testApp;
  };

  const startConsumer = () => testApp!.app.get(WagerTransactionConsumer).start();

  const transactionOf = async (envelope: RequestEnvelope) => {
    const response = await fetch(
      `${testApp!.baseUrl}/providers/${envelope.data.providerId}/wagering/transactions/${envelope.data.externalTransactionId}`,
    );
    return response.status === 200 ? ((await response.json()) as Record<string, unknown>) : undefined;
  };

  const waitForTransaction = async (envelope: RequestEnvelope) => {
    await waitUntil(async () => (await transactionOf(envelope)) !== undefined, {
      description: `transaction ${envelope.data.externalTransactionId}`,
    });
    return (await transactionOf(envelope))!;
  };

  const waitForEmptyQueue = () =>
    waitUntil(
      async () => {
        const depth = await queueDepth(sqs, queues.queueUrl);
        return depth.visible === 0 && depth.inFlight === 0;
      },
      { description: "the queue to be empty" },
    );

  const inboxRows = async (messageId: string) =>
    (await sql`SELECT processed_at FROM inbox_messages WHERE message_id = ${messageId}`).length as number;

  const debits = async (walletId: string) =>
    (await sql`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`)[0]
      .count as number;


  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
    sqs = testSqsClient();
  });

  beforeEach(async () => {
    queues = await createTestQueues(sqs);
  });

  afterEach(async () => {
    await testApp?.app.close();
    testApp = undefined;
    await assertAllWalletsMatchLedger(sql);
    expect(await queueDepth(sqs, queues.queueUrl)).toEqual({ visible: 0, inFlight: 0 });
    expect(await queueDepth(sqs, queues.deadLetterQueueUrl)).toEqual({ visible: 0, inFlight: 0 });
    await deleteTestQueues(sqs, queues);
  });

  afterAll(async () => {
    await sql.close();
    sqs.destroy();
  });

  test("a valid message is applied, recorded in the inbox and acknowledged after the commit", async () => {
    await startApp();
    const wallet = await client.openWallet("100.00");
    const envelope = requestEnvelope(wallet, "BET", "25.00");

    await sendEnvelope(sqs, queues.queueUrl, envelope, { correlationId: "corr-123" });
    const transaction = await waitForTransaction(envelope);
    await waitForEmptyQueue();

    expect(transaction).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00" } });
    expect(await inboxRows(envelope.messageId)).toBe(1);
    const events = await sql`
      SELECT event_type, payload->>'causationId' AS causation_id, payload->>'correlationId' AS correlation_id
        FROM outbox_messages WHERE aggregate_id = ${transaction.transactionId as string}`;
    expect(events).toEqual([
      { event_type: "WagerTransactionProcessed", causation_id: envelope.messageId, correlation_id: "corr-123" },
    ]);
  });

  test("the same message delivered twice has a single effect", async () => {
    await startApp({ SQS_CONSUMER_ENABLED: "false" });
    const wallet = await client.openWallet("100.00");
    const envelope = requestEnvelope(wallet, "BET", "25.00");
    await sendEnvelope(sqs, queues.queueUrl, envelope, { deduplicationId: "first-delivery" });
    await sendEnvelope(sqs, queues.queueUrl, envelope, { deduplicationId: "second-delivery" });

    startConsumer();
    await waitForTransaction(envelope);
    await waitForEmptyQueue();

    expect(await debits(wallet.id)).toBe(1);
    expect(await inboxRows(envelope.messageId)).toBe(1);
    expect(await client.balanceOf(wallet.id)).toBe("75.00");
  });

  test("a crash after the commit and before the ack is absorbed by the inbox", async () => {
    await startApp({ SQS_CONSUMER_ENABLED: "false" });
    const wallet = await client.openWallet("100.00");
    const envelope = requestEnvelope(wallet, "BET", "25.00");
    await sendEnvelope(sqs, queues.queueUrl, envelope);
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queues.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1, VisibilityTimeout: 30 }),
    );
    const delivered = Messages![0]!;
    await testApp!.app
      .get(HandleWagerTransactionRequested)
      .handle(
        toWagerTransactionRequest(parseWagerTransactionMessage(delivered.Body!), {
          consumerName: "wager-transactions-consumer",
          correlationId: envelope.messageId,
        }),
      );
    await sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: queues.queueUrl, ReceiptHandle: delivered.ReceiptHandle, VisibilityTimeout: 0 }),
    );

    startConsumer();
    await waitForEmptyQueue();

    expect(await debits(wallet.id)).toBe(1);
    expect(await inboxRows(envelope.messageId)).toBe(1);
    expect(await client.balanceOf(wallet.id)).toBe("75.00");
  });

  test("a transient failure is retried with backoff until it succeeds", async () => {
    await startApp({ DB_LOCK_TIMEOUT_MS: "300" });
    const wallet = await client.openWallet("100.00");
    const envelope = requestEnvelope(wallet, "BET", "25.00");

    await sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      await sendEnvelope(sqs, queues.queueUrl, envelope);
      await waitUntil(async () => (await rowLockWaiters(sql)) > 0, { description: "the consumer to wait for the wallet lock" });
      await Bun.sleep(700);
      expect(await transactionOf(envelope)).toBeUndefined();
    });
    const transaction = await waitForTransaction(envelope);
    await waitForEmptyQueue();

    expect(transaction.status).toBe("PROCESSED");
    expect(await debits(wallet.id)).toBe(1);
  });

  test("a failure that stays transient goes to the DLQ after maxReceiveCount", async () => {
    await startApp({ DB_LOCK_TIMEOUT_MS: "300" });
    const wallet = await client.openWallet("100.00");
    const envelope = requestEnvelope(wallet, "BET", "25.00");

    const deadLetters = await sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      await sendEnvelope(sqs, queues.queueUrl, envelope);
      return drainDeadLetters(sqs, queues.deadLetterQueueUrl, 1);
    });

    expect(deadLetters).toHaveLength(1);
    expect(JSON.parse(deadLetters[0]!.body).messageId).toBe(envelope.messageId);
    expect(deadLetters[0]!.attributes.errorCode).toBeUndefined();
    expect(await transactionOf(envelope)).toBeUndefined();
    expect(await inboxRows(envelope.messageId)).toBe(0);
  });

  test("permanent failures go straight to the DLQ with their error code", async () => {
    await startApp();
    const wallet = await client.openWallet("100.00");
    const unknownWallet = requestEnvelope({ id: Bun.randomUUIDv7(), playerId: wallet.playerId }, "BET", "10.00");
    const badAmount = requestEnvelope(wallet, "BET", "25.5");
    const foreignPlayer = requestEnvelope(wallet, "BET", "10.00", { playerId: Bun.randomUUIDv7() });

    await sendEnvelope(sqs, queues.queueUrl, unknownWallet);
    await sendEnvelope(sqs, queues.queueUrl, badAmount);
    await sendEnvelope(sqs, queues.queueUrl, foreignPlayer);
    await sendRaw(sqs, queues.queueUrl, "not json at all", { groupId: "garbage" });
    const deadLetters = await drainDeadLetters(sqs, queues.deadLetterQueueUrl, 4);

    const codeOf = (body: string) => deadLetters.find((letter) => letter.body === body)?.attributes;
    expect(codeOf(JSON.stringify(unknownWallet))).toMatchObject({ errorCode: "WALLET_NOT_FOUND", receiveCount: "1" });
    expect(codeOf(JSON.stringify(badAmount))).toMatchObject({ errorCode: "INVALID_MONEY", receiveCount: "1" });
    expect(codeOf(JSON.stringify(foreignPlayer))).toMatchObject({ errorCode: "WALLET_PLAYER_MISMATCH", receiveCount: "1" });
    expect(codeOf("not json at all")).toMatchObject({ errorCode: "INVALID_MESSAGE", consumerName: "wager-transactions-consumer" });
    for (const envelope of [unknownWallet, badAmount, foreignPlayer]) {
      expect(await inboxRows(envelope.messageId)).toBe(0);
      expect(await transactionOf(envelope)).toBeUndefined();
    }
    await waitForEmptyQueue();
    expect(await client.balanceOf(wallet.id)).toBe("100.00");
  });

  test("the same messageId with a different payload goes to the DLQ and keeps the original effect", async () => {
    await startApp();
    const wallet = await client.openWallet("100.00");
    const original = requestEnvelope(wallet, "BET", "10.00");
    await sendEnvelope(sqs, queues.queueUrl, original);
    await waitForTransaction(original);

    const impostor = { ...original, data: { ...original.data, money: { amount: "99.00", currency: "BRL" } } };
    await sendEnvelope(sqs, queues.queueUrl, impostor, { deduplicationId: "impostor" });
    const deadLetters = await drainDeadLetters(sqs, queues.deadLetterQueueUrl, 1);

    expect(deadLetters[0]!.attributes.errorCode).toBe("INBOX_PAYLOAD_MISMATCH");
    await waitForEmptyQueue();
    expect(await client.balanceOf(wallet.id)).toBe("90.00");
    expect(await debits(wallet.id)).toBe(1);
  });

  test("a business rejection is persisted and acknowledged without retry", async () => {
    await startApp();
    const wallet = await client.openWallet("10.00");
    const envelope = requestEnvelope(wallet, "BET", "25.00");

    await sendEnvelope(sqs, queues.queueUrl, envelope);
    const transaction = await waitForTransaction(envelope);
    await waitForEmptyQueue();

    expect(transaction).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "10.00" } });
    expect(await inboxRows(envelope.messageId)).toBe(1);
    const events = await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${transaction.transactionId as string}`;
    expect(events).toEqual([{ event_type: "WagerTransactionRejected" }]);
  });

  test("messages of the same group are applied in order, so a REFUND follows its BET", async () => {
    await startApp({ SQS_CONSUMER_ENABLED: "false" });
    const wallet = await client.openWallet("100.00");
    const bet = requestEnvelope(wallet, "BET", "10.00");
    const refund = requestEnvelope(wallet, "REFUND", "10.00", {
      referenceExternalTransactionId: bet.data.externalTransactionId,
    });
    await sendEnvelope(sqs, queues.queueUrl, bet);
    await sendEnvelope(sqs, queues.queueUrl, refund);

    startConsumer();
    const refunded = await waitForTransaction(refund);
    await waitForEmptyQueue();

    expect(refunded.status).toBe("PROCESSED");
    expect(await client.balanceOf(wallet.id)).toBe("100.00");
  });

  test("a batch spanning several wallets applies every message exactly once", async () => {
    await startApp({ SQS_CONSUMER_ENABLED: "false" });
    const wallets = await Promise.all(Array.from({ length: 10 }, () => client.openWallet("100.00")));
    const envelopes = wallets.flatMap((wallet) => Array.from({ length: 3 }, () => requestEnvelope(wallet, "BET", "5.00")));
    for (const envelope of envelopes) {
      await sendEnvelope(sqs, queues.queueUrl, envelope);
    }

    startConsumer();
    await waitUntil(
      async () =>
        (await sql`SELECT count(*)::int AS count FROM inbox_messages WHERE message_id IN ${sql(envelopes.map((envelope) => envelope.messageId))}`)[0]
          .count === envelopes.length,
      { description: "every message to be handled", timeoutMs: 20_000 },
    );
    await waitForEmptyQueue();

    for (const wallet of wallets) {
      expect(await client.balanceOf(wallet.id)).toBe("85.00");
    }
  });
});
