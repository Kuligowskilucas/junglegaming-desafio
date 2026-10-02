import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { AppProcess, logTails } from "../support/app-process";
import { connectSql, resetDatabase } from "../support/database";
import { FleetClient } from "../support/fleet-client";
import { useIntegrationEnvironment } from "../support/integration";
import { assertAllWalletsMatchLedger } from "../support/ledger-invariant";
import { discardPendingOutbox, outboxRows } from "../support/outbox";
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
import { keyOf, type WagerPayload, wager, type WalletHandle } from "../support/wagering-client";

useIntegrationEnvironment({ testTimeoutMs: 120_000 });

interface WalletPlan {
  wallet: WalletHandle;
  firstBets: WagerPayload[];
  wins: WagerPayload[];
  refund: WagerPayload;
  messages: RequestEnvelope[];
  lateBet: RequestEnvelope;
  laterBets: WagerPayload[];
}

const walletCount = 12;
const openingBalance = "1000.00";
const expectedBalance = "968.00";
const expectedEntries = 15;

function planFor(wallet: WalletHandle): WalletPlan {
  const lateBetId = `late-bet-${Bun.randomUUIDv7()}`;
  return {
    wallet,
    firstBets: Array.from({ length: 4 }, () => wager(wallet, "BET", "5.00")),
    wins: Array.from({ length: 2 }, () => wager(wallet, "WIN", "3.00")),
    refund: wager(wallet, "REFUND", "7.00", { referenceExternalTransactionId: lateBetId }),
    messages: Array.from({ length: 4 }, () => requestEnvelope(wallet, "BET", "2.00")),
    lateBet: requestEnvelope(wallet, "BET", "7.00", { externalTransactionId: lateBetId }),
    laterBets: Array.from({ length: 2 }, () => wager(wallet, "BET", "5.00")),
  };
}

describe("restarting the service", () => {
  let sql: SQL;
  let sqs: SQSClient;
  let queues: TestQueues;
  let events: EventsQueue;

  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
    sqs = testSqsClient();
    await discardPendingOutbox(sql);
    queues = await createTestQueues(sqs, { visibilityTimeoutSeconds: 2, maxReceiveCount: 10 });
    events = await createEventsQueue(sqs);
  });

  afterAll(async () => {
    await AppProcess.stopAll();
    await assertAllWalletsMatchLedger(sql);
    await deleteTestQueues(sqs, queues);
    await deleteEventsQueue(sqs, events);
    await sql.close();
    sqs.destroy();
  });

  test("after kill -9, SIGTERM and a full outage, every wallet reconciles and every message and event is accounted for", async () => {
    const environment = {
      SQS_CONSUMER_ENABLED: "true",
      OUTBOX_PUBLISHER_ENABLED: "true",
      REFERENCE_WORKER_ENABLED: "true",
      SQS_WAGER_QUEUE_NAME: queues.queueName,
      SQS_WAGER_DLQ_NAME: queues.deadLetterQueueName,
      SQS_EVENTS_QUEUE_NAME: events.queueName,
    };
    const startedAt = Date.now();
    const timeline: string[] = [];
    const mark = (step: string) => timeline.push(`${step} at ${Date.now() - startedAt} ms`);
    let fleet = await AppProcess.startMany(3, "first", environment);
    const client = new FleetClient(() => fleet);
    const plans = (await Promise.all(Array.from({ length: walletCount }, () => client.openWallet(openingBalance)))).map(planFor);
    mark("3 instances up and wallets opened");

    const httpLoad = Promise.all(
      plans.map(async (plan) => {
        const responses = [];
        for (const payload of [...plan.firstBets, ...plan.wins, plan.refund]) {
          responses.push(await client.submitWager(payload));
          await Bun.sleep(40);
        }
        return responses;
      }),
    );
    const messageLoad = Promise.all(
      plans.flatMap((plan) => plan.messages.map((message) => sendEnvelope(sqs, queues.queueUrl, message))),
    ).then(() =>
      Promise.all(
        plans.map((plan) => sendEnvelope(sqs, queues.queueUrl, plan.messages[0]!, { deduplicationId: Bun.randomUUIDv7() })),
      ),
    );
    await Bun.sleep(150);
    await fleet[0]!.kill();
    mark("instance 1 killed with SIGKILL during the load");
    const terminated = await fleet[1]!.terminate();
    mark(`instance 2 stopped by ${terminated.signal}`);
    const firstResponses = await httpLoad;
    await messageLoad;
    mark(`first load answered with ${client.retries} resend(s) to another instance`);

    for (const responses of firstResponses) {
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 202]);
    }

    await fleet[2]!.kill();
    mark("instance 3 killed with SIGKILL: no instance running");
    const pendingRefunds = await sql`
      SELECT count(*)::int AS count FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND idempotency_key IN ${sql(plans.map((plan) => keyOf(plan.refund)))}`;
    expect(pendingRefunds[0].count).toBe(walletCount);
    await Promise.all(plans.map((plan) => sendEnvelope(sqs, queues.queueUrl, plan.lateBet)));
    expect((await queueDepth(sqs, queues.queueUrl)).visible).toBeGreaterThanOrEqual(walletCount);
    mark("late bets queued during the outage");

    fleet = await AppProcess.startMany(3, "restarted", environment);
    mark("3 new instances up");
    const laterResponses = await Promise.all(
      plans.flatMap((plan) => plan.laterBets.map((payload) => client.submitWager(payload))),
    );
    expect(laterResponses.every((response) => response.status === 200)).toBe(true);

    const walletIds = plans.map((plan) => plan.wallet.id);
    const refundKeys = plans.map((plan) => keyOf(plan.refund));
    await waitUntil(
      async () => {
        const depth = await queueDepth(sqs, queues.queueUrl);
        const [{ unsettled }] = await sql`
          SELECT count(*)::int AS unsettled FROM wager_transactions
           WHERE idempotency_key IN ${sql(refundKeys)} AND status <> 'PROCESSED'`;
        const [{ pending }] = await sql`
          SELECT count(*)::int AS pending FROM outbox_messages
           WHERE published_at IS NULL AND ordering_key IN ${sql(walletIds)}`;
        return depth.visible === 0 && depth.inFlight === 0 && unsettled === 0 && pending === 0;
      },
      { description: "the restarted instances to finish the pending work", timeoutMs: 60_000 },
    ).catch(async (error) => {
      throw new Error(`${error}\n${await logTails(fleet)}`);
    });
    mark("quiescent: queue empty, refunds settled, outbox published");

    for (const plan of plans) {
      const { status, body } = await client.post<Record<string, unknown>>(`/wallets/${plan.wallet.id}/reconciliation`);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        storedBalance: { amount: expectedBalance },
        calculatedBalance: { amount: expectedBalance },
        consistent: true,
        checkedEntries: expectedEntries,
      });
    }

    const httpKeys = plans.flatMap((plan) => [...plan.firstBets, ...plan.wins, plan.refund, ...plan.laterBets].map(keyOf));
    const messageKeys = plans.flatMap((plan) => [...plan.messages, plan.lateBet].map((message) => message.data.idempotencyKey as string));
    const transactions = await sql`
      SELECT idempotency_key, status FROM wager_transactions WHERE idempotency_key IN ${sql([...httpKeys, ...messageKeys])}`;
    expect(transactions).toHaveLength(httpKeys.length + messageKeys.length);
    expect(transactions.every((row: { status: string }) => row.status === "PROCESSED")).toBe(true);

    const messageIds = plans.flatMap((plan) => [...plan.messages, plan.lateBet].map((message) => message.messageId));
    const [{ handled }] = await sql`
      SELECT count(*)::int AS handled FROM inbox_messages WHERE message_id IN ${sql(messageIds)}`;
    expect(handled).toBe(messageIds.length);
    expect(await queueDepth(sqs, queues.deadLetterQueueUrl)).toEqual({ visible: 0, inFlight: 0 });

    const entries = await sql`
      SELECT wallet_id::text, count(*)::int AS count FROM wallet_ledger_entries
       WHERE wallet_id IN ${sql(walletIds)} GROUP BY wallet_id`;
    expect(entries.map((row: { count: number }) => row.count)).toEqual(walletIds.map(() => expectedEntries));

    const outbox = await outboxRows(sql, { orderingKeys: walletIds });
    expect(outbox.every((row) => row.publishedAt !== null)).toBe(true);
    const received = await receiveEvents(sqs, events.queueUrl, outbox.length, { timeoutMs: 60_000 });
    const receivedIds = received.map((event) => event.eventId);
    expect(new Set(receivedIds)).toEqual(new Set(outbox.map((row) => row.id)));
    const duplicates = receivedIds.length - new Set(receivedIds).size;
    mark(`${outbox.length} events received, ${duplicates} duplicate(s)`);
    console.info(`[multiprocess] restart scenario:\n  ${timeline.join("\n  ")}`);
    expect(duplicates).toBe(0);
  });
});
