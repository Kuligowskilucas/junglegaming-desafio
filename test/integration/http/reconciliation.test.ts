import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, resetDatabase, shiftStoredBalanceBypassingTriggers } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import { LogCapture } from "../../support/log-capture";
import { scrapeMetrics } from "../../support/metrics";
import { wager, WageringClient } from "../../support/wagering-client";

useIntegrationEnvironment();

describe("POST /wallets/:walletId/reconciliation", () => {
  let sql: SQL;
  let testApp: TestApp;
  let client: WageringClient;
  const logs = new LogCapture();

  const reconcile = async (walletId: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${testApp.baseUrl}/wallets/${walletId}/reconciliation`, { method: "POST", headers });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const submitted = async (payload: ReturnType<typeof wager>) => {
    const response = await client.submitWager(payload);
    expect(response.status).toBe(200);
    return response;
  };

  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
    testApp = await createTestApp();
    logs.start("warn");
    client = WageringClient.retrying(testApp.baseUrl);
  });

  afterEach(async () => {
    await assertAllWalletsMatchLedger(sql);
  });

  afterAll(async () => {
    logs.stop();
    await testApp.app.close();
    await sql.close();
  });

  test("is consistent after every kind of movement and counts every ledger entry", async () => {
    const wallet = await client.openWallet("100.00");
    const bet = wager(wallet, "BET", "20.00");
    const win = wager(wallet, "WIN", "15.00");
    await submitted(wager(wallet, "BET", "30.00"));
    await submitted(wager(wallet, "WIN", "50.00"));
    await submitted(wager(wallet, "LOSS", "10.00"));
    await submitted(bet);
    await submitted(wager(wallet, "REFUND", "20.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    await submitted(win);
    await submitted(wager(wallet, "ROLLBACK", "15.00", { referenceExternalTransactionId: win.externalTransactionId }));

    const { status, body } = await reconcile(wallet.id);

    expect(status).toBe(200);
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "120.00", currency: "BRL" },
      calculatedBalance: { amount: "120.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 7,
    });
  });

  test("a wallet opened without balance reconciles at zero with no entries", async () => {
    const wallet = await client.openWallet("0.00");

    expect((await reconcile(wallet.id)).body).toMatchObject({
      storedBalance: { amount: "0.00", currency: "BRL" },
      calculatedBalance: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 0,
    });
  });

  test("an unknown wallet is 404 and a malformed id is 400", async () => {
    expect(await reconcile(Bun.randomUUIDv7())).toMatchObject({ status: 404, body: { code: "WALLET_NOT_FOUND" } });
    expect(await reconcile("not-a-uuid")).toMatchObject({ status: 400, body: { code: "VALIDATION_FAILED" } });
  });

  test("a divergence is reported, logged without balances, counted and never corrected", async () => {
    const wallet = await client.openWallet("100.00");
    await submitted(wager(wallet, "BET", "10.00"));
    const before = await scrapeMetrics(testApp.baseUrl);
    logs.clear();
    await shiftStoredBalanceBypassingTriggers(sql, wallet.id, "5.00");
    try {
      const { status, body } = await reconcile(wallet.id, { "x-correlation-id": "reconciliation-1" });

      expect(status).toBe(200);
      expect(body).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: "95.00", currency: "BRL" },
        calculatedBalance: { amount: "90.00", currency: "BRL" },
        difference: { amount: "5.00", currency: "BRL" },
        consistent: false,
        checkedEntries: 2,
      });
      expect(await client.balanceOf(wallet.id)).toBe("95.00");
      const divergences = logs.withMessage("Wallet reconciliation found a divergence");
      expect(divergences).toHaveLength(1);
      expect(divergences[0]).toMatchObject({
        level: "error",
        correlationId: "reconciliation-1",
        walletId: wallet.id,
        difference: { amount: "5.00", currency: "BRL" },
        checkedEntries: 2,
      });
      expect(divergences[0]).not.toContainKey("storedBalance");
      expect(divergences[0]).not.toContainKey("calculatedBalance");
      expect(logs.raw.join("")).not.toContain("95.00");
      expect(logs.raw.join("")).not.toContain("90.00");
      const after = await scrapeMetrics(testApp.baseUrl);
      expect(after.increaseSince(before, "wagering_reconciliations_total", { result: "inconsistent" })).toBe(1);
      expect(after.increaseSince(before, "wagering_reconciliations_total", { result: "consistent" })).toBe(0);
    } finally {
      await shiftStoredBalanceBypassingTriggers(sql, wallet.id, "-5.00");
    }
    expect((await reconcile(wallet.id)).body).toMatchObject({ consistent: true });
  });

  test("does not wait for a wallet lock held by an uncommitted write and reads the committed state", async () => {
    const wallet = await client.openWallet("100.00");
    let answer: { status: number; body: Record<string, unknown> } | undefined;
    let elapsedMs = 0;

    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE wallets SET balance = balance - 40.00, version = version + 1 WHERE id = ${wallet.id}`;
        const startedAt = performance.now();
        answer = await reconcile(wallet.id);
        elapsedMs = performance.now() - startedAt;
        throw new Error("roll back the uncommitted write");
      }),
    ).rejects.toThrow("roll back the uncommitted write");

    expect(elapsedMs).toBeLessThan(1_000);
    expect(answer).toMatchObject({
      status: 200,
      body: { storedBalance: { amount: "100.00" }, calculatedBalance: { amount: "100.00" }, consistent: true },
    });
  });

  test("reconciliations running alongside writes on the same wallet stay consistent", async () => {
    const wallet = await client.openWallet("1000.00");

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        index % 2 === 0 ? submitted(wager(wallet, "BET", "1.00")).then(() => undefined) : reconcile(wallet.id),
      ),
    );

    const reconciliations = results.filter((result) => result !== undefined);
    expect(reconciliations).toHaveLength(20);
    for (const reconciliation of reconciliations) {
      expect(reconciliation.body.consistent).toBe(true);
      expect(reconciliation.body.checkedEntries as number).toBeWithin(1, 22);
    }
    expect((await reconcile(wallet.id)).body).toMatchObject({
      storedBalance: { amount: "980.00" },
      consistent: true,
      checkedEntries: 21,
    });
  });
});
