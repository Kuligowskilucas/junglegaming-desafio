import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { OutboxPublisherWorker } from "../../../src/interfaces/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "../../../src/interfaces/workers/pending-reference.worker";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import { type MetricsSnapshot, scrapeMetrics } from "../../support/metrics";
import { discardPendingOutbox, pendingOutboxCount } from "../../support/outbox";
import {
  createEventsQueue,
  createTestQueues,
  deleteEventsQueue,
  deleteTestQueues,
  drainDeadLetters,
  type EventsQueue,
  eventsQueueName,
  requestEnvelope,
  sendEnvelope,
  sendRaw,
  type TestQueues,
  testSqsClient,
  waitUntil,
} from "../../support/sqs";
import { keyOf, wager, WageringClient, type WalletHandle } from "../../support/wagering-client";

useIntegrationEnvironment();

const catalog: [string, string][] = [
  ["wagering_transactions_total", "counter"],
  ["wagering_duplicates_total", "counter"],
  ["wagering_retries_total", "counter"],
  ["wagering_dead_lettered_total", "counter"],
  ["wagering_lock_conflicts_total", "counter"],
  ["wagering_reconciliations_total", "counter"],
  ["wagering_metrics_probe_failures_total", "counter"],
  ["wagering_processing_duration_seconds", "histogram"],
  ["wagering_outbox_publication_delay_seconds", "histogram"],
  ["wagering_wallet_lock_wait_seconds", "histogram"],
  ["wagering_outbox_pending_events", "gauge"],
  ["wagering_outbox_oldest_pending_age_seconds", "gauge"],
  ["wagering_pending_reference_transactions", "gauge"],
  ["wagering_sqs_queue_messages", "gauge"],
];

describe("metrics", () => {
  let sql: SQL;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: EventsQueue;
  const apps: TestApp[] = [];

  const startApp = async (overrides: Record<string, string> = {}) => {
    const testApp = await createTestApp({
      SQS_WAGER_QUEUE_NAME: queues.queueName,
      SQS_WAGER_DLQ_NAME: queues.deadLetterQueueName,
      SQS_EVENTS_QUEUE_NAME: events.queueName,
      SQS_WAIT_TIME_SECONDS: "1",
      SQS_RETRY_BASE_SECONDS: "1",
      SQS_RETRY_MAX_SECONDS: "1",
      DB_LOCK_TIMEOUT_MS: "300",
      OUTBOX_POLL_INTERVAL_MS: "100",
      REFERENCE_WORKER_POLL_INTERVAL_MS: "100",
      ...overrides,
    });
    apps.push(testApp);
    return { testApp, client: new WageringClient(testApp.baseUrl), scrape: () => scrapeMetrics(testApp.baseUrl) };
  };

  const waitForMetric = async (
    scrape: () => Promise<MetricsSnapshot>,
    condition: (snapshot: MetricsSnapshot) => boolean,
    description: string,
  ) => {
    await waitUntil(async () => condition(await scrape()), { description, timeoutMs: 15_000 });
    return scrape();
  };

  const waitForStatus = (client: WageringClient, providerId: string, externalTransactionId: string, status: string) =>
    waitUntil(async () => (await client.transaction(providerId, externalTransactionId))?.status === status, {
      description: `${externalTransactionId} to be ${status}`,
    });

  const holdingWalletLock = <T>(wallet: WalletHandle, work: () => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      return work();
    });

  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
    sqs = testSqsClient();
  });

  beforeEach(async () => {
    await discardPendingOutbox(sql);
    queues = await createTestQueues(sqs);
    events = await createEventsQueue(sqs);
  });

  afterEach(async () => {
    for (const testApp of apps.splice(0)) {
      await testApp.app.close();
    }
    await assertAllWalletsMatchLedger(sql);
    await deleteTestQueues(sqs, queues);
    await deleteEventsQueue(sqs, events);
  });

  afterAll(async () => {
    await sql.close();
    sqs.destroy();
  });

  test("exposes the whole catalog in the Prometheus text format without authentication", async () => {
    const { testApp } = await startApp();

    const response = await fetch(`${testApp.baseUrl}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/plain;");
    expect(response.headers.get("content-type")).toContain("version=0.0.4");
    for (const [name, type] of catalog) {
      expect(text).toContain(`# TYPE ${name} ${type}`);
    }
    expect(text).toContain("# TYPE process_cpu_user_seconds_total counter");
  });

  test("counts HTTP transactions by status, replays as duplicates, and observes latency and lock waits", async () => {
    const { client, scrape } = await startApp();
    const before = await scrape();
    const wallet = await client.openWallet("50.00");
    const bet = wager(wallet, "BET", "20.00");

    expect((await client.submitWager(bet)).status).toBe(200);
    expect((await client.submitWager(bet)).body.idempotentReplay).toBe(true);
    expect((await client.submitWager(wager(wallet, "BET", "100.00"))).status).toBe(422);
    const after = await scrape();

    const transactions = (kind: string, status: string, failureCode = "none") =>
      after.increaseSince(before, "wagering_transactions_total", { source: "http", kind, status, failure_code: failureCode });
    expect(transactions("OPENING", "PROCESSED")).toBe(1);
    expect(transactions("BET", "PROCESSED")).toBe(1);
    expect(transactions("BET", "REJECTED", "INSUFFICIENT_FUNDS")).toBe(1);
    expect(after.increaseSince(before, "wagering_duplicates_total", { source: "http", type: "idempotent_replay" })).toBe(1);
    for (const result of ["PROCESSED", "REJECTED", "REPLAY"]) {
      expect(after.increaseSince(before, "wagering_processing_duration_seconds_count", { source: "http", result })).toBe(1);
    }
    expect(after.increaseSince(before, "wagering_wallet_lock_wait_seconds_count")).toBeGreaterThanOrEqual(2);
  });

  test("a lock timeout counts once as a conflict over HTTP and in the consumer, next to the consumer retry", async () => {
    const { client, scrape } = await startApp({ SQS_CONSUMER_ENABLED: "true" });
    const wallet = await client.openWallet("100.00");
    const before = await scrape();

    const blocked = await holdingWalletLock(wallet, () => {
      const bet = wager(wallet, "BET", "10.00");
      return client.submit(bet, keyOf(bet));
    });
    expect(blocked.status).toBe(503);
    const afterHttp = await scrape();
    expect(afterHttp.increaseSince(before, "wagering_lock_conflicts_total", { type: "timeout" })).toBe(1);
    expect(afterHttp.increaseSince(before, "wagering_processing_duration_seconds_count", { source: "http", result: "ERROR" })).toBe(1);

    const envelope = requestEnvelope(wallet, "BET", "10.00");
    await holdingWalletLock(wallet, async () => {
      await sendEnvelope(sqs, queues.queueUrl, envelope);
      await waitForMetric(
        scrape,
        (snapshot) =>
          snapshot.increaseSince(afterHttp, "wagering_retries_total", {
            component: "sqs_consumer",
            reason: "DEPENDENCY_UNAVAILABLE",
          }) >= 1,
        "a consumer retry",
      );
    });
    await waitForStatus(client, envelope.data.providerId as string, envelope.data.externalTransactionId, "PROCESSED");
    const after = await scrape();

    const consumerRetries = after.increaseSince(afterHttp, "wagering_retries_total", {
      component: "sqs_consumer",
      reason: "DEPENDENCY_UNAVAILABLE",
    });
    expect(consumerRetries).toBeGreaterThanOrEqual(1);
    expect(after.increaseSince(afterHttp, "wagering_lock_conflicts_total", { type: "timeout" })).toBe(consumerRetries);
    expect(after.increaseSince(afterHttp, "wagering_processing_duration_seconds_count", { source: "sqs", result: "RETRY" })).toBe(
      consumerRetries,
    );
    expect(
      after.increaseSince(afterHttp, "wagering_transactions_total", {
        source: "sqs",
        kind: "BET",
        status: "PROCESSED",
        failure_code: "none",
      }),
    ).toBe(1);
  });

  test("counts inbox duplicates and dead letters and exposes the dead-letter queue depth", async () => {
    const { client, scrape } = await startApp({ SQS_CONSUMER_ENABLED: "true" });
    const wallet = await client.openWallet("100.00");
    const before = await scrape();
    const envelope = requestEnvelope(wallet, "BET", "5.00");

    await sendEnvelope(sqs, queues.queueUrl, envelope);
    await waitForStatus(client, envelope.data.providerId as string, envelope.data.externalTransactionId, "PROCESSED");
    await sendEnvelope(sqs, queues.queueUrl, envelope, { deduplicationId: Bun.randomUUIDv7() });
    await sendRaw(sqs, queues.queueUrl, "not json", { groupId: wallet.id });
    const after = await waitForMetric(
      scrape,
      (snapshot) =>
        snapshot.increaseSince(before, "wagering_duplicates_total", { source: "sqs", type: "inbox" }) === 1 &&
        snapshot.increaseSince(before, "wagering_dead_lettered_total", { code: "INVALID_MESSAGE" }) === 1,
      "the duplicate and the dead letter",
    );

    expect(after.value("wagering_sqs_queue_messages", { queue: "requests_dlq", state: "visible" })).toBe(1);
    expect(after.increaseSince(before, "wagering_processing_duration_seconds_count", { source: "sqs", result: "DUPLICATE" })).toBe(1);
    expect(
      after.increaseSince(before, "wagering_processing_duration_seconds_count", { source: "sqs", result: "DEAD_LETTER" }),
    ).toBe(1);
    expect(
      after.increaseSince(before, "wagering_transactions_total", {
        source: "sqs",
        kind: "BET",
        status: "PROCESSED",
        failure_code: "none",
      }),
    ).toBe(1);
    await drainDeadLetters(sqs, queues.deadLetterQueueUrl, 1);
  });

  test("measures the outbox lag while events wait and drops it to zero once they are published", async () => {
    const { testApp, client, scrape } = await startApp();
    await client.openWallet("100.00");
    await Bun.sleep(1_100);

    const waiting = await scrape();
    expect(waiting.value("wagering_outbox_pending_events")).toBe(2);
    expect(waiting.value("wagering_outbox_oldest_pending_age_seconds")!).toBeGreaterThanOrEqual(1);

    testApp.app.get(OutboxPublisherWorker).start();
    await waitUntil(async () => (await pendingOutboxCount(sql)) === 0, { description: "the outbox to drain" });
    const published = await scrape();

    expect(published.value("wagering_outbox_pending_events")).toBe(0);
    expect(published.value("wagering_outbox_oldest_pending_age_seconds")).toBe(0);
    expect(published.increaseSince(waiting, "wagering_outbox_publication_delay_seconds_count")).toBe(2);
    expect(published.value("wagering_sqs_queue_messages", { queue: "events", state: "visible" })).toBe(2);
  });

  test("tracks the pending reference backlog, the worker outcomes and its retries", async () => {
    const { testApp, client, scrape } = await startApp();
    const wallet = await client.openWallet("100.00");
    const before = await scrape();
    const bet = wager(wallet, "BET", "10.00");
    const refund = wager(wallet, "REFUND", "10.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const orphan = wager(wallet, "REFUND", "10.00", { referenceExternalTransactionId: `missing-${Bun.randomUUIDv7()}` });

    expect((await client.submitWager(refund)).status).toBe(202);
    expect((await client.submitWager(orphan)).status).toBe(202);
    const waiting = await scrape();
    expect(waiting.increaseSince(before, "wagering_pending_reference_transactions")).toBe(2);

    expect((await client.submitWager(bet)).status).toBe(200);
    testApp.app.get(PendingReferenceWorker).start();
    await waitForStatus(client, refund.providerId, refund.externalTransactionId, "PROCESSED");
    const after = await waitForMetric(
      scrape,
      (snapshot) =>
        snapshot.increaseSince(before, "wagering_retries_total", {
          component: "reference_worker",
          reason: "REFERENCE_MISSING",
        }) >= 1,
      "a worker retry of the orphan refund",
    );

    expect(after.increaseSince(before, "wagering_pending_reference_transactions")).toBe(1);
    expect(
      after.increaseSince(before, "wagering_transactions_total", {
        source: "http",
        kind: "REFUND",
        status: "PENDING_REFERENCE",
        failure_code: "none",
      }),
    ).toBe(2);
    expect(
      after.increaseSince(before, "wagering_transactions_total", {
        source: "worker",
        kind: "REFUND",
        status: "PROCESSED",
        failure_code: "none",
      }),
    ).toBe(1);
    expect(after.increaseSince(before, "wagering_processing_duration_seconds_count", { source: "worker", result: "PROCESSED" })).toBe(
      1,
    );
  });

  test("a failing probe reports NaN and is counted without breaking the scrape", async () => {
    const { scrape } = await startApp({ SQS_EVENTS_QUEUE_NAME: eventsQueueName() });

    const snapshot = await scrape();

    expect(snapshot.value("wagering_sqs_queue_messages", { queue: "events", state: "visible" })).toBeNaN();
    expect(snapshot.value("wagering_sqs_queue_messages", { queue: "requests", state: "visible" })).toBe(0);
    expect(snapshot.value("wagering_metrics_probe_failures_total", { probe: "sqs" })).toBe(1);
    expect(snapshot.value("wagering_outbox_pending_events")).toBe(0);
  });
});
