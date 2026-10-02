import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import { keyOf, type WagerPayload, WageringClient, type WalletHandle, wager } from "../../support/wagering-client";

useIntegrationEnvironment();

describe("wagering submission against the real database", () => {
  let testApp: TestApp;
  let sql: SQL;
  let client: WageringClient;

  const eventsOf = async (aggregateId: string) =>
    (
      await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${aggregateId} ORDER BY occurred_at, event_type`
    ).map((row: { event_type: string }) => row.event_type);

  const outboxSize = async () => (await sql`SELECT count(*)::int AS count FROM outbox_messages`)[0].count as number;

  const view = async (transactionId: string) =>
    (await (await fetch(`${testApp.baseUrl}/wagering/transactions/${transactionId}`)).json()) as Record<string, unknown>;

  const externalLookup = (payload: WagerPayload) =>
    fetch(`${testApp.baseUrl}/providers/${payload.providerId}/wagering/transactions/${payload.externalTransactionId}`);

  const processed = async (payload: WagerPayload) => {
    const response = await client.submitWager(payload);
    expect(response.status).toBe(200);
    return response.body;
  };

  const expectRejected = async (payload: WagerPayload, failureCode: string, balance: string) => {
    const response = await client.submitWager(payload);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 422,
      code: failureCode,
      failureCode,
      transactionStatus: "REJECTED",
      balance: { amount: balance, currency: "BRL" },
      idempotentReplay: false,
      retryable: false,
    });
    const transactionId = response.body.transactionId as string;
    expect(await view(transactionId)).toMatchObject({ status: "REJECTED", failureCode });
    expect(await eventsOf(transactionId)).toEqual(["WagerTransactionRejected"]);
    return response.body;
  };

  const expectNotPersisted = async (payload: WagerPayload) => {
    expect((await externalLookup(payload)).status).toBe(404);
  };

  beforeAll(async () => {
    await resetDatabase();
    testApp = await createTestApp();
    sql = connectSql();
    client = new WageringClient(testApp.baseUrl);
  });

  afterEach(async () => {
    await assertAllWalletsMatchLedger(sql);
  });

  afterAll(async () => {
    await sql.close();
    await testApp.app.close();
  });

  describe("each kind", () => {
    let wallet: WalletHandle;

    beforeAll(async () => {
      wallet = await client.openWallet("100.00");
    });

    test("BET debits and emits WagerTransactionProcessed and WalletBalanceChanged", async () => {
      const payload = wager(wallet, "BET", "25.00");

      const response = await client.submitWager(payload);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        transactionId: expect.any(String),
        status: "PROCESSED",
        balance: { amount: "75.00", currency: "BRL" },
        idempotentReplay: false,
      });
      expect(await eventsOf(response.body.transactionId as string)).toEqual(["WagerTransactionProcessed"]);
      expect(await eventsOf(wallet.id)).toEqual(["WalletBalanceChanged", "WalletBalanceChanged"]);
    });

    test("WIN credits, with or without a reference to the BET of the round", async () => {
      const bet = wager(wallet, "BET", "10.00", { roundId: "round-win" });
      await processed(bet);

      const plainWin = await processed(wager(wallet, "WIN", "5.00"));
      const referencedWin = await processed(
        wager(wallet, "WIN", "30.00", { roundId: "round-win", referenceExternalTransactionId: bet.externalTransactionId }),
      );

      expect(plainWin.balance).toEqual({ amount: "70.00", currency: "BRL" });
      expect(referencedWin.balance).toEqual({ amount: "100.00", currency: "BRL" });
      expect((await view(referencedWin.transactionId as string)).referenceTransactionId).toBe(
        ((await (await externalLookup(bet)).json()) as { transactionId: string }).transactionId,
      );
    });

    test("LOSS is processed without moving the balance nor writing the ledger", async () => {
      const [{ version: versionBefore }] = await sql`SELECT version::int AS version FROM wallets WHERE id = ${wallet.id}`;

      const loss = await processed(wager(wallet, "LOSS", "0.00"));

      expect(loss.balance).toEqual({ amount: await client.balanceOf(wallet.id), currency: "BRL" });
      const [{ version: versionAfter }] = await sql`SELECT version::int AS version FROM wallets WHERE id = ${wallet.id}`;
      expect(versionAfter).toBe(versionBefore);
      expect(await sql`SELECT id FROM wallet_ledger_entries WHERE transaction_id = ${loss.transactionId as string}`).toHaveLength(0);
      expect(await eventsOf(loss.transactionId as string)).toEqual(["WagerTransactionProcessed"]);
    });

    test("REFUND and ROLLBACK reverse BET, WIN and REFUND in the right direction", async () => {
      const start = Number(await client.balanceOf(wallet.id));
      const amountAfter = (delta: number) => (start + delta).toFixed(2);

      const bet = wager(wallet, "BET", "10.00", { roundId: "round-reversals" });
      await processed(bet);
      const refund = wager(wallet, "REFUND", "10.00", { roundId: "round-reversals", referenceExternalTransactionId: bet.externalTransactionId });
      expect((await processed(refund)).balance).toEqual({ amount: amountAfter(0), currency: "BRL" });

      const rollbackOfRefund = wager(wallet, "ROLLBACK", "10.00", { roundId: "round-reversals", referenceExternalTransactionId: refund.externalTransactionId });
      expect((await processed(rollbackOfRefund)).balance).toEqual({ amount: amountAfter(-10), currency: "BRL" });

      const win = wager(wallet, "WIN", "7.00", { roundId: "round-reversals" });
      await processed(win);
      const rollbackOfWin = wager(wallet, "ROLLBACK", "7.00", { roundId: "round-reversals", referenceExternalTransactionId: win.externalTransactionId });
      expect((await processed(rollbackOfWin)).balance).toEqual({ amount: amountAfter(-10), currency: "BRL" });

      const otherBet = wager(wallet, "BET", "4.00", { roundId: "round-reversals" });
      await processed(otherBet);
      const rollbackOfBet = wager(wallet, "ROLLBACK", "4.00", { roundId: "round-reversals", referenceExternalTransactionId: otherBet.externalTransactionId });
      expect((await processed(rollbackOfBet)).balance).toEqual({ amount: amountAfter(-10), currency: "BRL" });
    });
  });

  describe("references delivered out of order", () => {
    test.each(["REFUND", "ROLLBACK"])("%s before its BET waits as PENDING_REFERENCE", async (kind) => {
      const wallet = await client.openWallet("100.00");
      const bet = wager(wallet, "BET", "10.00");
      const reversal = wager(wallet, kind, "10.00", { referenceExternalTransactionId: bet.externalTransactionId });

      const early = await client.submitWager(reversal);

      expect(early.status).toBe(202);
      expect(early.body).toEqual({
        transactionId: expect.any(String),
        status: "PENDING_REFERENCE",
        balance: null,
        idempotentReplay: false,
      });
      const pending = await view(early.body.transactionId as string);
      expect(pending).toMatchObject({ status: "PENDING_REFERENCE", referenceAttempts: 1, balance: null });
      expect(pending.nextReferenceAttemptAt).toEqual(expect.any(String));
      expect(await eventsOf(early.body.transactionId as string)).toEqual(["WagerTransactionPendingReference"]);

      await processed(bet);
      const replay = await client.submitWager(reversal);

      expect(replay.status).toBe(202);
      expect(replay.body).toMatchObject({ transactionId: early.body.transactionId, idempotentReplay: true });
      expect((await view(early.body.transactionId as string)).status).toBe("PENDING_REFERENCE");
      expect(await client.balanceOf(wallet.id)).toBe("90.00");
    });
  });

  describe("idempotency", () => {
    test("a replay returns the balance observed back then, without new events", async () => {
      const wallet = await client.openWallet("100.00");
      const first = wager(wallet, "BET", "10.00");
      const original = await processed(first);
      await processed(wager(wallet, "BET", "20.00"));
      const eventsBefore = await outboxSize();

      const replay = await client.submitWager(first);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...original, idempotentReplay: true });
      expect(replay.body.balance).toEqual({ amount: "90.00", currency: "BRL" });
      expect(await client.balanceOf(wallet.id)).toBe("70.00");
      expect(await outboxSize()).toBe(eventsBefore);
    });

    test("a replay of a rejection is the same 422", async () => {
      const wallet = await client.openWallet("5.00");
      const bet = wager(wallet, "BET", "10.00");
      const original = await expectRejected(bet, "INSUFFICIENT_FUNDS", "5.00");

      const replay = await client.submitWager(bet);

      expect(replay.status).toBe(422);
      expect(replay.body).toMatchObject({
        transactionId: original.transactionId,
        failureCode: "INSUFFICIENT_FUNDS",
        balance: { amount: "5.00", currency: "BRL" },
        idempotentReplay: true,
      });
    });

    test("the same key with a different payload is a 409 conflict, not a replay", async () => {
      const wallet = await client.openWallet("100.00");
      const bet = wager(wallet, "BET", "10.00");
      const original = await processed(bet);

      const response = await client.submit({ ...bet, money: { amount: "11.00", currency: "BRL" } }, keyOf(bet));

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", transactionId: original.transactionId });
      expect(await client.balanceOf(wallet.id)).toBe("90.00");
    });

    test("the same external id under another key is a 409 duplicate", async () => {
      const wallet = await client.openWallet("100.00");
      const bet = wager(wallet, "BET", "10.00");
      const original = await processed(bet);

      const response = await client.submit(bet, `another-key-${Bun.randomUUIDv7()}`);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "DUPLICATE_EXTERNAL_TRANSACTION_ID", transactionId: original.transactionId });
    });
  });

  describe("business rejections are persisted and answered with 422", () => {
    test("INSUFFICIENT_FUNDS", async () => {
      const wallet = await client.openWallet("50.00");

      await expectRejected(wager(wallet, "BET", "50.01"), "INSUFFICIENT_FUNDS", "50.00");
    });

    test("REVERSAL_INSUFFICIENT_FUNDS is distinct from a bet without funds", async () => {
      const wallet = await client.openWallet("100.00");
      const win = wager(wallet, "WIN", "50.00");
      await processed(win);
      await processed(wager(wallet, "BET", "150.00"));

      await expectRejected(
        wager(wallet, "ROLLBACK", "50.00", { referenceExternalTransactionId: win.externalTransactionId }),
        "REVERSAL_INSUFFICIENT_FUNDS",
        "0.00",
      );
    });

    test("CURRENCY_MISMATCH", async () => {
      const wallet = await client.openWallet("100.00");

      await expectRejected(wager(wallet, "BET", "10.00", { money: { amount: "10.00", currency: "USD" } }), "CURRENCY_MISMATCH", "100.00");
    });

    test("REFERENCE_INVALID_KIND, REFERENCE_AMOUNT_MISMATCH and REFERENCE_MISMATCH", async () => {
      const wallet = await client.openWallet("100.00");
      const bet = wager(wallet, "BET", "10.00");
      const win = wager(wallet, "WIN", "10.00");
      await processed(bet);
      await processed(win);

      await expectRejected(wager(wallet, "REFUND", "10.00", { referenceExternalTransactionId: win.externalTransactionId }), "REFERENCE_INVALID_KIND", "100.00");
      await expectRejected(wager(wallet, "REFUND", "5.00", { referenceExternalTransactionId: bet.externalTransactionId }), "REFERENCE_AMOUNT_MISMATCH", "100.00");
      await expectRejected(
        wager(wallet, "REFUND", "10.00", { roundId: "another-round", referenceExternalTransactionId: bet.externalTransactionId }),
        "REFERENCE_MISMATCH",
        "100.00",
      );
    });

    test("REFERENCE_ALREADY_REVERSED, also for a ROLLBACK after a REFUND of the same BET", async () => {
      const wallet = await client.openWallet("100.00");
      const bet = wager(wallet, "BET", "10.00");
      await processed(bet);
      await processed(wager(wallet, "REFUND", "10.00", { referenceExternalTransactionId: bet.externalTransactionId }));

      await expectRejected(wager(wallet, "REFUND", "10.00", { referenceExternalTransactionId: bet.externalTransactionId }), "REFERENCE_ALREADY_REVERSED", "100.00");
      await expectRejected(wager(wallet, "ROLLBACK", "10.00", { referenceExternalTransactionId: bet.externalTransactionId }), "REFERENCE_ALREADY_REVERSED", "100.00");
    });
  });

  describe("requests that are refused without being persisted", () => {
    let wallet: WalletHandle;

    beforeAll(async () => {
      wallet = await client.openWallet("100.00");
    });

    test("a player that does not own the wallet gets 422 without any balance", async () => {
      const payload = wager(wallet, "BET", "10.00", { playerId: Bun.randomUUIDv7() });

      const response = await client.submitWager(payload);

      expect(response.status).toBe(422);
      expect(response.body.code).toBe("WALLET_PLAYER_MISMATCH");
      expect(response.body).not.toHaveProperty("balance");
      await expectNotPersisted(payload);
    });

    test("an unknown wallet is a 404", async () => {
      const payload = wager({ id: Bun.randomUUIDv7(), playerId: wallet.playerId }, "BET", "10.00");

      const response = await client.submitWager(payload);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe("WALLET_NOT_FOUND");
      await expectNotPersisted(payload);
    });

    test("the Idempotency-Key header is required and validated", async () => {
      const payload = wager(wallet, "BET", "10.00");

      const missing = await client.submit(payload, undefined);
      const malformed = await client.submit(payload, "key with spaces");

      expect([missing.status, missing.body.code]).toEqual([400, "MISSING_IDEMPOTENCY_KEY"]);
      expect([malformed.status, malformed.body.code]).toEqual([400, "VALIDATION_FAILED"]);
      await expectNotPersisted(payload);
    });

    test.each([
      ["OPENING", "INTERNAL_KIND"],
      ["JACKPOT", "UNKNOWN_KIND"],
    ])("kind %s is an invalid wager transaction (%s)", async (kind, reason) => {
      const payload = wager(wallet, kind, "10.00");

      const response = await client.submitWager(payload);

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "INVALID_WAGER_TRANSACTION", reason });
      await expectNotPersisted(payload);
    });

    test("REFUND without reference and amounts without two decimals are rejected as invalid payloads", async () => {
      const refund = wager(wallet, "REFUND", "10.00");
      const badAmount = wager(wallet, "BET", "25.5");

      const refundResponse = await client.submitWager(refund);
      const amountResponse = await client.submitWager(badAmount);

      expect(refundResponse.body).toMatchObject({ code: "INVALID_WAGER_TRANSACTION", reason: "REFERENCE_REQUIRED" });
      expect(amountResponse.body).toMatchObject({ code: "INVALID_MONEY", reason: "INVALID_SCALE" });
      await expectNotPersisted(refund);
      await expectNotPersisted(badAmount);
    });

    test("a body outside the schema is a 400 validation problem", async () => {
      const payload = { ...wager(wallet, "BET", "10.00"), unexpected: true };

      const response = await client.submit(payload, keyOf(payload));

      expect([response.status, response.body.code]).toEqual([400, "VALIDATION_FAILED"]);
    });
  });

  describe("queries", () => {
    test("a transaction is found by id and by provider and external id", async () => {
      const wallet = await client.openWallet("100.00");
      const bet = wager(wallet, "BET", "10.00");
      const { transactionId } = await processed(bet);

      const byId = await view(transactionId as string);
      const byExternal = (await (await externalLookup(bet)).json()) as Record<string, unknown>;

      expect(byId).toEqual(byExternal);
      expect(byId).toMatchObject({
        transactionId,
        providerId: "provider-a",
        externalTransactionId: bet.externalTransactionId,
        idempotencyKey: keyOf(bet),
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
        status: "PROCESSED",
        failureCode: null,
        balance: { amount: "90.00", currency: "BRL" },
        referenceAttempts: 0,
        processedAt: expect.any(String),
      });
    });

    test("unknown transactions are 404 and malformed ids are 400", async () => {
      const unknownById = await fetch(`${testApp.baseUrl}/wagering/transactions/${Bun.randomUUIDv7()}`);
      const unknownExternal = await fetch(`${testApp.baseUrl}/providers/provider-a/wagering/transactions/nope`);
      const malformed = await fetch(`${testApp.baseUrl}/wagering/transactions/abc`);

      expect(unknownById.status).toBe(404);
      expect(((await unknownById.json()) as { code: string }).code).toBe("TRANSACTION_NOT_FOUND");
      expect(unknownExternal.status).toBe(404);
      expect(malformed.status).toBe(400);
    });

    test("the internal OPENING is visible under the internal provider", async () => {
      const wallet = await client.openWallet("100.00");

      const response = await fetch(`${testApp.baseUrl}/providers/internal/wagering/transactions/opening:${wallet.id}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ kind: "OPENING", status: "PROCESSED", balance: { amount: "100.00" } });
    });
  });
});
