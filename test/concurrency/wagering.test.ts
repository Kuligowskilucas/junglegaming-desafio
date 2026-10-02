import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestApp, type TestApp } from "../support/create-test-app";
import { connectSql, resetDatabase } from "../support/database";
import { useIntegrationEnvironment } from "../support/integration";
import { assertAllWalletsMatchLedger } from "../support/ledger-invariant";
import { keyOf, type SubmissionResponse, WageringClient, type WalletHandle, wager } from "../support/wagering-client";

useIntegrationEnvironment();

const retriesByScenario = new Map<string, number>();

describe("wagering under real concurrency", () => {
  let testApp: TestApp;
  let sql: SQL;

  const entries = async (walletId: string, direction: "DEBIT" | "CREDIT") =>
    (
      await sql`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = ${direction}`
    )[0].count as number;

  const statuses = (responses: SubmissionResponse[]) => responses.map((response) => response.status).sort();

  const scenario = async <T>(name: string, run: (client: WageringClient) => Promise<T>): Promise<T> => {
    const client = WageringClient.retrying(testApp.baseUrl);
    try {
      return await run(client);
    } finally {
      retriesByScenario.set(name, client.retriedAfter503);
    }
  };

  beforeAll(async () => {
    await resetDatabase();
    testApp = await createTestApp();
    sql = connectSql();
  });

  afterEach(async () => {
    await assertAllWalletsMatchLedger(sql);
  });

  afterAll(async () => {
    console.info(
      `[concurrency] retries after 503 per scenario:\n${[...retriesByScenario]
        .map(([name, retries]) => `  ${name}: ${retries}`)
        .join("\n")}`,
    );
    await sql.close();
    await testApp.app.close();
  });

  test("section 8: two bets of 80.00 on 100.00 leave one debit and 20.00", async () => {
    await scenario("section 8", async (client) => {
      const wallet = await client.openWallet("100.00");
      const bets = [wager(wallet, "BET", "80.00"), wager(wallet, "BET", "80.00")];

      const responses = await Promise.all(bets.map((bet) => client.submitWager(bet)));

      expect(statuses(responses)).toEqual([200, 422]);
      expect(responses.find((response) => response.status === 422)?.body.code).toBe("INSUFFICIENT_FUNDS");
      expect(await client.balanceOf(wallet.id)).toBe("20.00");
      expect(await entries(wallet.id, "DEBIT")).toBe(1);

      const replays = await Promise.all(bets.map((bet) => client.submitWager(bet)));

      replays.forEach((replay, index) => {
        expect(replay.status).toBe(responses[index]?.status as number);
        expect(replay.body).toMatchObject({ transactionId: responses[index]?.body.transactionId, idempotentReplay: true });
      });
      expect(await entries(wallet.id, "DEBIT")).toBe(1);
      expect(await client.balanceOf(wallet.id)).toBe("20.00");
    });
  });

  test("the same bet sent 50 times in parallel debits once", async () => {
    await scenario("same bet x50", async (client) => {
      const wallet = await client.openWallet("1000.00");
      const bet = wager(wallet, "BET", "25.00");

      const responses = await Promise.all(Array.from({ length: 50 }, () => client.submitWager(bet)));

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
      expect(responses.every((response) => (response.body.balance as { amount: string }).amount === "975.00")).toBe(true);
      expect(responses.filter((response) => response.body.idempotentReplay === false)).toHaveLength(1);
      expect(await entries(wallet.id, "DEBIT")).toBe(1);
      expect(await client.balanceOf(wallet.id)).toBe("975.00");
      const events = await sql`
        SELECT event_type, count(*)::int AS count FROM outbox_messages
         WHERE aggregate_id IN (${wallet.id}, ${responses[0]?.body.transactionId as string})
         GROUP BY event_type ORDER BY event_type`;
      expect(events).toEqual([
        { event_type: "WagerTransactionProcessed", count: 1 },
        { event_type: "WalletBalanceChanged", count: 2 },
      ]);
    });
  });

  test("a hot wallet: 120 different bets of 10.00 on 1000.00 process exactly 100", async () => {
    await scenario("hot wallet x120", async (client) => {
      const wallet = await client.openWallet("1000.00");

      const responses = await Promise.all(
        Array.from({ length: 120 }, () => client.submitWager(wager(wallet, "BET", "10.00"))),
      );

      expect(responses.filter((response) => response.status === 200)).toHaveLength(100);
      expect(responses.filter((response) => response.status === 422 && response.body.code === "INSUFFICIENT_FUNDS")).toHaveLength(20);
      expect(await client.balanceOf(wallet.id)).toBe("0.00");
      expect(await entries(wallet.id, "DEBIT")).toBe(100);
      const [{ version }] = await sql`SELECT version::int AS version FROM wallets WHERE id = ${wallet.id}`;
      expect(version).toBe(101);
    });
  });

  test("ten wallets with twenty bets each, all at once, keep exact balances", async () => {
    await scenario("10 wallets x20", async (client) => {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => client.openWallet("1000.00")));

      const responses = await Promise.all(
        wallets.flatMap((wallet) => Array.from({ length: 20 }, () => client.submitWager(wager(wallet, "BET", "7.00")))),
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
      for (const wallet of wallets) {
        expect(await client.balanceOf(wallet.id)).toBe("860.00");
        expect(await entries(wallet.id, "DEBIT")).toBe(20);
      }
    });
  });

  test("a REFUND and a ROLLBACK of the same BET in parallel reverse it once", async () => {
    await scenario("refund vs rollback", async (client) => {
      const wallet = await client.openWallet("100.00");
      for (let round = 0; round < 10; round += 1) {
        const bet = wager(wallet, "BET", "10.00");
        expect((await client.submitWager(bet)).status).toBe(200);
        const reference = { referenceExternalTransactionId: bet.externalTransactionId };

        const responses = await Promise.all([
          client.submitWager(wager(wallet, "REFUND", "10.00", reference)),
          client.submitWager(wager(wallet, "ROLLBACK", "10.00", reference)),
        ]);

        expect(statuses(responses)).toEqual([200, 422]);
        expect(responses.find((response) => response.status === 422)?.body.code).toBe("REFERENCE_ALREADY_REVERSED");
        expect(await client.balanceOf(wallet.id)).toBe("100.00");
      }
      expect(await entries(wallet.id, "CREDIT")).toBe(11);
    });
  });

  test("the same key for payloads of different wallets never becomes a 500", async () => {
    await scenario("same key, different wallets", async (client) => {
      const first = await client.openWallet("100.00");
      const second = await client.openWallet("100.00");
      for (let round = 0; round < 10; round += 1) {
        const key = `provider-a:shared-${Bun.randomUUIDv7()}`;

        const responses = await Promise.all([
          client.submit(wager(first, "BET", "1.00"), key),
          client.submit(wager(second, "BET", "1.00"), key),
        ]);

        expect(statuses(responses)).toEqual([200, 409]);
        expect(responses.find((response) => response.status === 409)?.body.code).toBe("IDEMPOTENCY_CONFLICT");
      }
      const balances = [await client.balanceOf(first.id), await client.balanceOf(second.id)].map(Number);
      expect(balances[0]! + balances[1]!).toBe(190);
    });
  });

  test("the same external id under different keys never becomes a 500", async () => {
    await scenario("same external id, different keys", async (client) => {
      const wallet = await client.openWallet("100.00");
      for (let round = 0; round < 10; round += 1) {
        const bet = wager(wallet, "BET", "1.00");

        const responses = await Promise.all([
          client.submit(bet, `key-a-${Bun.randomUUIDv7()}`),
          client.submit(bet, `key-b-${Bun.randomUUIDv7()}`),
        ]);

        expect(statuses(responses)).toEqual([200, 409]);
        expect(responses.find((response) => response.status === 409)?.body.code).toBe("DUPLICATE_EXTERNAL_TRANSACTION_ID");
      }
      expect(await client.balanceOf(wallet.id)).toBe("90.00");
    });
  });

  describe("lock timeout", () => {
    let impatientApp: TestApp;

    beforeAll(async () => {
      impatientApp = await createTestApp({ DB_LOCK_TIMEOUT_MS: "300" });
    });

    afterAll(async () => {
      await impatientApp.app.close();
    });

    test("waiting too long for a wallet lock is a retryable 503, and the retry succeeds", async () => {
      const client = new WageringClient(impatientApp.baseUrl);
      const wallet: WalletHandle = await client.openWallet("100.00");
      const bet = wager(wallet, "BET", "10.00");

      const blocked = await sql.begin(async (tx) => {
        await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
        return client.submit(bet, keyOf(bet));
      });

      expect(blocked.status).toBe(503);
      expect(blocked.retryAfter).toBe("1");
      expect(blocked.body).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", retryable: true });
      expect(await client.balanceOf(wallet.id)).toBe("100.00");

      const retried = await client.submit(bet, keyOf(bet));

      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ status: "PROCESSED", idempotentReplay: false, balance: { amount: "90.00" } });
    });
  });
});
