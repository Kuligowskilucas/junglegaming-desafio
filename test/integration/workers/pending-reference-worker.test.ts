import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { backoffDelayMs } from "../../../src/domain/shared/retry-backoff";
import { referenceRetryPolicy } from "../../../src/domain/wagering/wager-transaction";
import { PendingReferenceWorker } from "../../../src/interfaces/workers/pending-reference.worker";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import { outboxRows } from "../../support/outbox";
import { waitUntil } from "../../support/sqs";
import { type WagerPayload, wager, WageringClient, type WalletHandle } from "../../support/wagering-client";

useIntegrationEnvironment();

describe("pending reference worker", () => {
  let sql: SQL;
  const apps: TestApp[] = [];

  const startApp = async (overrides: Record<string, string> = {}) => {
    const testApp = await createTestApp({ REFERENCE_WORKER_POLL_INTERVAL_MS: "100", ...overrides });
    apps.push(testApp);
    return { testApp, client: WageringClient.retrying(testApp.baseUrl) };
  };

  const startWorker = (testApp: TestApp) => testApp.app.get(PendingReferenceWorker).start();

  const waitForStatus = async (client: WageringClient, payload: WagerPayload, status: string, timeoutMs = 10_000) => {
    await waitUntil(
      async () => (await client.transaction(payload.providerId, payload.externalTransactionId))?.status === status,
      { description: `${payload.kind} ${payload.externalTransactionId} to be ${status}`, timeoutMs },
    );
    return (await client.transaction(payload.providerId, payload.externalTransactionId))!;
  };

  const ledgerEntriesOf = async (transactionId: string) =>
    (await sql`
      SELECT direction, amount::text AS amount FROM wallet_ledger_entries WHERE transaction_id = ${transactionId}
    `) as { direction: string; amount: string }[];

  const submitPending = async (client: WageringClient, payload: WagerPayload, headers: Record<string, string> = {}) => {
    const response = await client.submitWager(payload, headers);
    expect(response.status).toBe(202);
    expect(response.body.status).toBe("PENDING_REFERENCE");
    return response.body.transactionId as string;
  };

  const refundBeforeBet = (wallet: WalletHandle, amount: string) => {
    const bet = wager(wallet, "BET", amount);
    const refund = wager(wallet, "REFUND", amount, { referenceExternalTransactionId: bet.externalTransactionId });
    return { bet, refund };
  };

  const prepareDueRefunds = async (client: WageringClient, wallets: WalletHandle[]) => {
    const pairs = wallets.map((wallet) => refundBeforeBet(wallet, "10.00"));
    const refundIds = await Promise.all(pairs.map(({ refund }) => submitPending(client, refund)));
    const bets = await Promise.all(pairs.map(({ bet }) => client.submitWager(bet)));
    expect(bets.map((response) => response.status)).toEqual(pairs.map(() => 200));
    return { pairs, refundIds };
  };

  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
  });

  afterEach(async () => {
    for (const testApp of apps.splice(0)) {
      await testApp.app.close();
    }
    await assertAllWalletsMatchLedger(sql);
  });

  afterAll(async () => {
    await sql.close();
  });

  test("a REFUND that arrived before its BET is processed after the BET with the original correlation", async () => {
    const { client } = await startApp({ REFERENCE_WORKER_ENABLED: "true" });
    const wallet = await client.openWallet("100.00");
    const { bet, refund } = refundBeforeBet(wallet, "10.00");
    const refundId = await submitPending(client, refund, { "x-correlation-id": "refund-request-1" });
    const betResponse = await client.submitWager(bet);
    expect(betResponse.status).toBe(200);

    const settled = await waitForStatus(client, refund, "PROCESSED");

    expect(settled).toMatchObject({
      referenceTransactionId: betResponse.body.transactionId,
      balance: { amount: "100.00", currency: "BRL" },
      failureCode: null,
    });
    expect(await client.balanceOf(wallet.id)).toBe("100.00");
    expect(await ledgerEntriesOf(refundId)).toEqual([{ direction: "CREDIT", amount: "10.00" }]);
    const events = await outboxRows(sql, { transactionId: refundId });
    expect(events.map((event) => event.eventType)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    expect(events.map((event) => event.payload.correlationId)).toEqual(events.map(() => "refund-request-1"));
    expect(events.slice(1).map((event) => event.payload.causationId)).toEqual([undefined, undefined]);
  });

  test("a ROLLBACK that arrived before its WIN debits the win once the WIN is processed", async () => {
    const { client } = await startApp({ REFERENCE_WORKER_ENABLED: "true" });
    const wallet = await client.openWallet("100.00");
    const win = wager(wallet, "WIN", "30.00");
    const rollback = wager(wallet, "ROLLBACK", "30.00", { referenceExternalTransactionId: win.externalTransactionId });
    const rollbackId = await submitPending(client, rollback);
    expect((await client.submitWager(win)).status).toBe(200);
    expect(await client.balanceOf(wallet.id)).toBe("130.00");

    await waitForStatus(client, rollback, "PROCESSED");

    expect(await client.balanceOf(wallet.id)).toBe("100.00");
    expect(await ledgerEntriesOf(rollbackId)).toEqual([{ direction: "DEBIT", amount: "30.00" }]);
  });

  test("the reference being processed brings forward a dependent that was waiting a long backoff", async () => {
    const { testApp, client } = await startApp();
    const wallet = await client.openWallet("100.00");
    const { bet, refund } = refundBeforeBet(wallet, "10.00");
    const refundId = await submitPending(client, refund);
    await sql`
      UPDATE wager_transactions SET next_reference_attempt_at = now() + interval '1 hour' WHERE id = ${refundId}
    `;
    startWorker(testApp);
    await Bun.sleep(300);
    expect((await client.transaction(refund.providerId, refund.externalTransactionId))!.referenceAttempts).toBe(1);

    expect((await client.submitWager(bet)).status).toBe(200);

    await waitForStatus(client, refund, "PROCESSED", 5_000);
    expect(await client.balanceOf(wallet.id)).toBe("100.00");
  });

  test("retries without the reference keep it pending with backoff and publish no new event", async () => {
    const { testApp, client } = await startApp();
    const wallet = await client.openWallet("100.00");
    const { refund } = refundBeforeBet(wallet, "10.00");
    const refundId = await submitPending(client, refund);
    startWorker(testApp);

    await waitUntil(
      async () => ((await client.transaction(refund.providerId, refund.externalTransactionId))!.referenceAttempts as number) >= 3,
      { description: "two retries", timeoutMs: 10_000 },
    );

    const pending = (await client.transaction(refund.providerId, refund.externalTransactionId))!;
    const attempts = pending.referenceAttempts as number;
    expect(pending.status).toBe("PENDING_REFERENCE");
    expect(
      new Date(pending.nextReferenceAttemptAt as string).getTime() - new Date(pending.updatedAt as string).getTime(),
    ).toBe(backoffDelayMs(referenceRetryPolicy, attempts));
    expect((await outboxRows(sql, { transactionId: refundId })).map((event) => event.eventType)).toEqual([
      "WagerTransactionPendingReference",
    ]);
  });

  test("a dependent that exhausts its attempts is rejected with REFERENCE_NOT_FOUND and the rejection is published", async () => {
    const { testApp, client } = await startApp();
    const wallet = await client.openWallet("100.00");
    const { refund } = refundBeforeBet(wallet, "10.00");
    const refundId = await submitPending(client, refund, { "x-correlation-id": "refund-request-2" });
    await sql`
      UPDATE wager_transactions
         SET reference_attempts = ${referenceRetryPolicy.maxAttempts}, next_reference_attempt_at = now()
       WHERE id = ${refundId}
    `;
    startWorker(testApp);

    const rejected = await waitForStatus(client, refund, "REJECTED");

    expect(rejected).toMatchObject({ failureCode: "REFERENCE_NOT_FOUND", balance: { amount: "100.00", currency: "BRL" } });
    expect(await client.balanceOf(wallet.id)).toBe("100.00");
    expect(await ledgerEntriesOf(refundId)).toEqual([]);
    const events = await outboxRows(sql, { transactionId: refundId });
    expect(events.map((event) => [event.eventType, event.payload.correlationId])).toEqual([
      ["WagerTransactionPendingReference", "refund-request-2"],
      ["WagerTransactionRejected", "refund-request-2"],
    ]);
    const replay = await client.submitWager(refund);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ code: "REFERENCE_NOT_FOUND", idempotentReplay: true });
  });

  test("resending a submission after the worker resolved it replays the final outcome", async () => {
    const { client } = await startApp({ REFERENCE_WORKER_ENABLED: "true" });
    const wallet = await client.openWallet("100.00");
    const { bet, refund } = refundBeforeBet(wallet, "10.00");
    const refundId = await submitPending(client, refund);
    expect((await client.submitWager(bet)).status).toBe(200);
    await waitForStatus(client, refund, "PROCESSED");
    expect((await client.submitWager(wager(wallet, "BET", "25.00"))).status).toBe(200);

    const replay = await client.submitWager(refund);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      transactionId: refundId,
      status: "PROCESSED",
      balance: { amount: "100.00", currency: "BRL" },
      idempotentReplay: true,
    });
    expect(await client.balanceOf(wallet.id)).toBe("75.00");
  });

  test("the worker and concurrent HTTP bets on the same wallet keep the balance exact", async () => {
    const { testApp, client } = await startApp();
    const wallet = await client.openWallet("1000.00");
    const { refundIds } = await prepareDueRefunds(client, Array.from({ length: 10 }, () => wallet));
    expect(await client.balanceOf(wallet.id)).toBe("900.00");

    startWorker(testApp);
    const bets = await Promise.all(Array.from({ length: 20 }, () => client.submitWager(wager(wallet, "BET", "5.00"))));
    await waitUntil(
      async () =>
        (await Promise.all(refundIds.map(ledgerEntriesOf))).every((entries) => entries.length === 1),
      { description: "every refund to be credited" },
    );

    expect(bets.map((response) => response.status)).toEqual(bets.map(() => 200));
    expect(await client.balanceOf(wallet.id)).toBe("900.00");
    for (const refundId of refundIds) {
      expect(await ledgerEntriesOf(refundId)).toEqual([{ direction: "CREDIT", amount: "10.00" }]);
    }
  });

  test("two workers resolve each due dependent exactly once", async () => {
    const first = await startApp();
    const second = await startApp();
    const wallets = await Promise.all(Array.from({ length: 10 }, () => first.client.openWallet("100.00")));
    const { pairs, refundIds } = await prepareDueRefunds(first.client, wallets);

    startWorker(first.testApp);
    startWorker(second.testApp);
    await Promise.all(pairs.map(({ refund }) => waitForStatus(first.client, refund, "PROCESSED")));

    for (const refundId of refundIds) {
      expect(await ledgerEntriesOf(refundId)).toEqual([{ direction: "CREDIT", amount: "10.00" }]);
      expect((await outboxRows(sql, { transactionId: refundId })).map((event) => event.eventType)).toEqual([
        "WagerTransactionPendingReference",
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
    }
    for (const wallet of wallets) {
      expect(await first.client.balanceOf(wallet.id)).toBe("100.00");
    }
  });
});
