import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import { LogCapture, type LogLine } from "../../support/log-capture";
import { discardPendingOutbox, pendingOutboxCount } from "../../support/outbox";
import {
  createEventsQueue,
  createTestQueues,
  deleteEventsQueue,
  deleteTestQueues,
  type EventsQueue,
  requestEnvelope,
  sendEnvelope,
  type TestQueues,
  testSqsClient,
  waitUntil,
} from "../../support/sqs";
import { keyOf, wager, WageringClient } from "../../support/wagering-client";

useIntegrationEnvironment();

const forbiddenKeys = ["money", "amount", "balance", "payload", "body", "headers", "playerId", "detail"];

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...keysOf(nested)]);
  }
  return [];
}

describe("structured logs", () => {
  let sql: SQL;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: EventsQueue;
  let testApp: TestApp;
  let client: WageringClient;
  const logs = new LogCapture();

  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
    sqs = testSqsClient();
    queues = await createTestQueues(sqs);
    events = await createEventsQueue(sqs);
    testApp = await createTestApp({
      DB_LOCK_TIMEOUT_MS: "300",
      SQS_CONSUMER_ENABLED: "true",
      SQS_WAGER_QUEUE_NAME: queues.queueName,
      SQS_WAGER_DLQ_NAME: queues.deadLetterQueueName,
      SQS_WAIT_TIME_SECONDS: "1",
      SQS_EVENTS_QUEUE_NAME: events.queueName,
      OUTBOX_PUBLISHER_ENABLED: "true",
      OUTBOX_POLL_INTERVAL_MS: "100",
      REFERENCE_WORKER_ENABLED: "true",
      REFERENCE_WORKER_POLL_INTERVAL_MS: "100",
    });
    logs.start("info");
    client = new WageringClient(testApp.baseUrl);
    await discardPendingOutbox(sql);
  });

  afterAll(async () => {
    logs.stop();
    await testApp.app.close();
    await assertAllWalletsMatchLedger(sql);
    await deleteTestQueues(sqs, queues);
    await deleteEventsQueue(sqs, events);
    await sql.close();
    sqs.destroy();
  });

  test("HTTP, consumer, worker and publisher log the identifiers of section 12 and no payload values", async () => {
    const canary = {
      opening: "4321.09",
      amount: "987.65",
      gameId: `canary-game-${Bun.randomUUIDv7()}`,
      roundId: `canary-round-${Bun.randomUUIDv7()}`,
    };
    const wallet = await client.openWallet(canary.opening);
    const bet = wager(wallet, "BET", canary.amount, { gameId: canary.gameId, roundId: canary.roundId });
    const refund = wager(wallet, "REFUND", canary.amount, {
      gameId: canary.gameId,
      roundId: canary.roundId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const envelope = requestEnvelope(wallet, "BET", canary.amount, {
      externalTransactionId: bet.externalTransactionId,
      gameId: canary.gameId,
      roundId: canary.roundId,
    });

    const pendingRefund = await client.submitWager(refund, { "x-correlation-id": "logs-refund" });
    expect(pendingRefund.status).toBe(202);
    await sendEnvelope(sqs, queues.queueUrl, envelope, { correlationId: "logs-bet" });
    await waitUntil(
      async () => (await client.transaction(refund.providerId, refund.externalTransactionId))?.status === "PROCESSED",
      { description: "the worker to settle the refund" },
    );
    await waitUntil(async () => (await pendingOutboxCount(sql)) === 0, { description: "every event to be published" });
    const blockedBet = wager(wallet, "BET", canary.amount, { gameId: canary.gameId, roundId: canary.roundId });
    const blocked = await sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      return client.submit(blockedBet, keyOf(blockedBet), { "x-correlation-id": "logs-blocked" });
    });
    expect(blocked.status).toBe(503);

    const lines = logs.lines;
    const refundId = pendingRefund.body.transactionId as string;
    const betId = (await client.transaction(bet.providerId, bet.externalTransactionId))!.transactionId as string;
    const requestLog = (correlationId: string) =>
      lines.find(
        (line) =>
          (line.message === "request completed" || line.message === "request errored") &&
          line.correlationId === correlationId,
      );

    expect(requestLog("logs-refund")).toMatchObject({
      transactionId: refundId,
      walletId: wallet.id,
      providerId: "provider-a",
      res: { statusCode: 202 },
    });
    expect(lines.find((line) => line.message === "Wager transaction message handled")).toMatchObject({
      correlationId: "logs-bet",
      messageId: envelope.messageId,
      transactionId: betId,
      walletId: wallet.id,
      providerId: "provider-a",
    });
    expect(lines.find((line) => line.message === "Pending reference transaction evaluated")).toMatchObject({
      worker: "pending-reference",
      correlationId: "logs-refund",
      transactionId: refundId,
      walletId: wallet.id,
      providerId: "provider-a",
      status: "PROCESSED",
    });
    const published = lines.filter((line) => line.message === "Outbox event published" && line.walletId === wallet.id);
    expect(published).toHaveLength(7);
    for (const line of published) {
      expect(line).toMatchObject({ worker: "outbox-publisher", eventId: expect.any(String), correlationId: expect.any(String) });
      expect(line.transactionId).toEqual(expect.any(String));
      if ((line.eventType as string).startsWith("WagerTransaction")) {
        expect(["provider-a", "internal"]).toContain(line.providerId as string);
      }
    }
    expect(published.filter((line) => line.transactionId === refundId).map((line) => line.correlationId)).toEqual([
      "logs-refund",
      "logs-refund",
      "logs-refund",
    ]);
    const failure = lines.find((line) => line.message === "Request failed" && line.correlationId === "logs-blocked");
    expect(failure).toMatchObject({
      level: "error",
      walletId: wallet.id,
      providerId: "provider-a",
      err: { code: "55P03" },
    });
    expect(Object.keys(failure!.err as LogLine).sort()).toEqual(["code", "message", "stack", "type"]);
    expect(requestLog("logs-blocked")).toMatchObject({ walletId: wallet.id, providerId: "provider-a", res: { statusCode: 503 } });

    const everything = logs.raw.join("");
    for (const value of Object.values(canary)) {
      expect(everything).not.toContain(value);
    }
    expect(keysOf(lines).filter((key) => forbiddenKeys.includes(key))).toEqual([]);
    expect(logs.duplicatedKeys()).toEqual([]);
  });
});
