import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { AppProcess } from "../support/app-process";
import { connectSql, resetDatabase } from "../support/database";
import { useIntegrationEnvironment } from "../support/integration";
import { assertAllWalletsMatchLedger } from "../support/ledger-invariant";
import type { MetricsSnapshot } from "../support/metrics";
import { wager, WageringClient, type WalletHandle } from "../support/wagering-client";

useIntegrationEnvironment({ testTimeoutMs: 120_000 });

describe("three application processes over HTTP", () => {
  let sql: SQL;
  let instances: AppProcess[];
  let clients: WageringClient[];

  const debits = async (walletId: string) =>
    (
      await sql`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`
    )[0].count as number;

  const scrapeAll = () => Promise.all(instances.map((instance) => instance.metrics()));

  const increase = (after: MetricsSnapshot[], before: MetricsSnapshot[], name: string, labels: Record<string, string>) =>
    after.map((snapshot, index) => snapshot.increaseSince(before[index]!, name, labels));

  beforeAll(async () => {
    await resetDatabase();
    sql = connectSql();
    instances = await AppProcess.startMany(3, "http");
    clients = instances.map((instance) => WageringClient.retrying(instance.baseUrl));
  });

  afterEach(async () => {
    await assertAllWalletsMatchLedger(sql);
  });

  afterAll(async () => {
    await AppProcess.stopAll();
    await sql.close();
  });

  test("the same bet sent 50 times in parallel across the processes debits once", async () => {
    const wallet = await clients[0]!.openWallet("100.00");
    const bet = wager(wallet, "BET", "10.00");
    const before = await scrapeAll();

    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => clients[index % 3]!.submitWager(bet)));

    expect(responses.map((response) => response.status)).toEqual(responses.map(() => 200));
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.filter((response) => response.body.idempotentReplay === false)).toHaveLength(1);
    expect(await clients[2]!.balanceOf(wallet.id)).toBe("90.00");
    expect(await debits(wallet.id)).toBe(1);
    const after = await scrapeAll();
    const processed = increase(after, before, "wagering_transactions_total", { source: "http", kind: "BET", status: "PROCESSED" });
    const replays = increase(after, before, "wagering_duplicates_total", { source: "http", type: "idempotent_replay" });
    expect(processed.reduce((total, count) => total + count, 0)).toBe(1);
    expect(replays.reduce((total, count) => total + count, 0)).toBe(49);
    expect(replays.filter((count) => count > 0).length).toBeGreaterThanOrEqual(2);
  });

  test("section 8 split across processes: one of two 80.00 bets on 100.00 wins, in every wallet", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, index) => clients[index % 3]!.openWallet("100.00")));
    const pairs = wallets.map((wallet) => [wager(wallet, "BET", "80.00"), wager(wallet, "BET", "80.00")] as const);

    const outcomes = await Promise.all(
      pairs.map(([first, second], index) =>
        Promise.all([clients[index % 3]!.submitWager(first), clients[(index + 1) % 3]!.submitWager(second)]),
      ),
    );

    for (const [index, wallet] of wallets.entries()) {
      const statuses = outcomes[index]!.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 422]);
      expect(outcomes[index]!.find((response) => response.status === 422)!.body.code).toBe("INSUFFICIENT_FUNDS");
      expect(await clients[(index + 2) % 3]!.balanceOf(wallet.id)).toBe("20.00");
      expect(await debits(wallet.id)).toBe(1);
    }
    const resent = await Promise.all(
      pairs.map(([first, second], index) =>
        Promise.all([clients[(index + 2) % 3]!.submitWager(first), clients[(index + 2) % 3]!.submitWager(second)]),
      ),
    );
    for (const [index, pair] of resent.entries()) {
      expect(pair.map((response) => response.status)).toEqual(outcomes[index]!.map((response) => response.status));
      expect(pair.every((response) => response.body.idempotentReplay === true)).toBe(true);
    }
    for (const wallet of wallets) {
      expect(await debits(wallet.id)).toBe(1);
    }
  });

  test("distinct wallets are processed in parallel by every process with exact balances", async () => {
    const wallets: WalletHandle[] = await Promise.all(Array.from({ length: 10 }, () => clients[0]!.openWallet("1000.00")));
    const before = await scrapeAll();

    const responses = await Promise.all(
      wallets.flatMap((wallet, walletIndex) =>
        Array.from({ length: 30 }, (_, betIndex) =>
          clients[(walletIndex + betIndex) % 3]!.submitWager(wager(wallet, "BET", "1.00")),
        ),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    for (const wallet of wallets) {
      expect(await clients[1]!.balanceOf(wallet.id)).toBe("970.00");
      expect(await debits(wallet.id)).toBe(30);
    }
    const processed = increase(await scrapeAll(), before, "wagering_transactions_total", {
      source: "http",
      kind: "BET",
      status: "PROCESSED",
    });
    expect(processed).toEqual([100, 100, 100]);
  });
});
