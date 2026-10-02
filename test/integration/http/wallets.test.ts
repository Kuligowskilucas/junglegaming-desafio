import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind";
import { AuthGuard } from "../../../src/interfaces/http/auth/auth.guard";
import { HealthController } from "../../../src/interfaces/http/health/health.controller";
import { WalletsController } from "../../../src/interfaces/http/wallets/wallets.controller";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, expectConstraintViolation, initOrm, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { applyTransaction } from "../../support/persistence";

useIntegrationEnvironment();

interface WalletBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface LedgerBody {
  items: { walletVersion: number; createdAt: string; direction: string }[];
  nextCursor: string | null;
}

describe("wallet endpoints against the real database", () => {
  let testApp: TestApp;
  let orm: MikroORM;
  let sql: SQL;

  const openWallet = (body: unknown) =>
    fetch(`${testApp.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const walletRequest = (playerId: string, amount = "1000.00", currency = "BRL") => ({
    playerId,
    initialBalance: { amount, currency },
  });

  const ledgerPage = async (walletId: string, query: string): Promise<LedgerBody> => {
    const response = await fetch(`${testApp.baseUrl}/wallets/${walletId}/ledger?${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as LedgerBody;
  };

  const countFor = async (playerId: string) => {
    const [row] = await sql`
      SELECT (SELECT count(*)::int FROM wallets WHERE player_id = ${playerId}) AS wallets,
             (SELECT count(*)::int FROM wager_transactions WHERE player_id = ${playerId}) AS transactions,
             (SELECT count(*)::int FROM wallet_ledger_entries e JOIN wallets w ON w.id = e.wallet_id
               WHERE w.player_id = ${playerId}) AS entries,
             (SELECT count(*)::int FROM outbox_messages) AS outbox`;
    return row as { wallets: number; transactions: number; entries: number; outbox: number };
  };

  beforeAll(async () => {
    await resetDatabase();
    testApp = await createTestApp();
    orm = await initOrm();
    sql = connectSql();
  });

  afterAll(async () => {
    await sql.close();
    await orm.close();
    await testApp.app.close();
  });

  describe("POST /wallets", () => {
    test("opens the wallet, the OPENING credit and its events in one transaction", async () => {
      const playerId = Bun.randomUUIDv7();

      const response = await openWallet(walletRequest(playerId));
      const body = (await response.json()) as WalletBody;

      expect(response.status).toBe(201);
      expect(response.headers.get("location")).toBe(`/wallets/${body.id}`);
      expect(body).toEqual({
        id: expect.any(String),
        playerId,
        balance: { amount: "1000.00", currency: "BRL" },
        version: 1,
      });
      const [opening] = await sql`
        SELECT id, kind, status, provider_id, amount::text, observed_balance::text
          FROM wager_transactions WHERE wallet_id = ${body.id}`;
      expect(opening).toMatchObject({
        kind: "OPENING",
        status: "PROCESSED",
        provider_id: "internal",
        amount: "1000.00",
        observed_balance: "1000.00",
      });
      const entries = await sql`
        SELECT wallet_version, transaction_id, direction, balance_before::text, balance_after::text
          FROM wallet_ledger_entries WHERE wallet_id = ${body.id}`;
      expect(entries).toEqual([
        { wallet_version: "1", transaction_id: opening.id, direction: "CREDIT", balance_before: "0.00", balance_after: "1000.00" },
      ]);
      const events = await sql`
        SELECT event_type, payload->>'correlationId' AS correlation_id FROM outbox_messages
         WHERE aggregate_id IN (${body.id}, ${opening.id}) ORDER BY event_type`;
      expect(events.map((event: { event_type: string }) => event.event_type)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
      expect(events[0].correlation_id).toBe(response.headers.get("x-correlation-id"));
    });

    test("an empty wallet has no OPENING, no ledger entry and no event", async () => {
      const playerId = Bun.randomUUIDv7();
      const before = await countFor(playerId);

      const response = await openWallet(walletRequest(playerId, "0.00"));

      expect(response.status).toBe(201);
      expect(((await response.json()) as WalletBody).balance.amount).toBe("0.00");
      expect(await countFor(playerId)).toEqual({ wallets: 1, transactions: 0, entries: 0, outbox: before.outbox });
    });

    test("an amount without exactly two decimals is a 400 problem with its reason", async () => {
      const response = await openWallet(walletRequest(Bun.randomUUIDv7(), "25.5"));

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toMatchObject({
        type: "urn:wagering:problem:invalid-money",
        status: 400,
        code: "INVALID_MONEY",
        reason: "INVALID_SCALE",
        retryable: false,
        instance: "/wallets",
      });
    });

    test("a body outside the schema is a 400 listing every issue", async () => {
      const response = await openWallet({ playerId: "not-a-uuid", initialBalance: { amount: "1.00" }, extra: true });
      const problem = (await response.json()) as { code: string; errors: { path: string }[] };

      expect(response.status).toBe(400);
      expect(problem.code).toBe("VALIDATION_FAILED");
      expect(problem.errors.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["playerId", "initialBalance.currency", ""]),
      );
    });

    test("a failure in the middle of the transaction leaves nothing behind", async () => {
      const playerId = Bun.randomUUIDv7();
      const before = await countFor(playerId);
      await sql.unsafe(`
        CREATE FUNCTION test_fail_ledger_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'simulated ledger failure';
        END
        $$`);
      await sql.unsafe(`
        CREATE TRIGGER test_fail_ledger_insert BEFORE INSERT ON wallet_ledger_entries
          FOR EACH ROW EXECUTE FUNCTION test_fail_ledger_insert()`);
      let failed: Response;
      try {
        failed = await openWallet(walletRequest(playerId));
      } finally {
        await sql.unsafe("DROP TRIGGER test_fail_ledger_insert ON wallet_ledger_entries");
        await sql.unsafe("DROP FUNCTION test_fail_ledger_insert()");
      }

      expect(failed.status).toBe(500);
      expect(((await failed.json()) as { code: string }).code).toBe("INTERNAL_ERROR");
      expect(await countFor(playerId)).toEqual({ wallets: 0, transactions: 0, entries: 0, outbox: before.outbox });

      const retried = await openWallet(walletRequest(playerId));
      expect(retried.status).toBe(201);
      expect(await countFor(playerId)).toEqual({ wallets: 1, transactions: 1, entries: 1, outbox: before.outbox + 2 });
    });

    test("a second wallet for the same player and currency is a 409 pointing to the existing one", async () => {
      const playerId = Bun.randomUUIDv7();
      const created = (await (await openWallet(walletRequest(playerId))).json()) as WalletBody;

      const response = await openWallet(walletRequest(playerId, "5.00"));

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "WALLET_ALREADY_EXISTS",
        walletId: created.id,
        retryable: false,
      });
    });

    test("ten concurrent requests for the same player and currency create exactly one wallet", async () => {
      const playerId = Bun.randomUUIDv7();
      const before = await countFor(playerId);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => openWallet(walletRequest(playerId))),
      );
      const bodies = await Promise.all(responses.map((response) => response.json()));

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
      const created = bodies[responses.findIndex((response) => response.status === 201)] as WalletBody;
      expect(bodies.filter((body) => (body as { code?: string }).code === "WALLET_ALREADY_EXISTS")).toEqual(
        Array.from({ length: 9 }, () => expect.objectContaining({ walletId: created.id })),
      );
      expect(await countFor(playerId)).toEqual({ wallets: 1, transactions: 1, entries: 1, outbox: before.outbox + 2 });
    });

    test("the same currency for another player and another currency for the same player are allowed", async () => {
      const playerId = Bun.randomUUIDv7();
      await openWallet(walletRequest(playerId));

      expect((await openWallet(walletRequest(Bun.randomUUIDv7()))).status).toBe(201);
      expect((await openWallet(walletRequest(playerId, "10.00", "USD"))).status).toBe(201);
    });
  });

  describe("GET /wallets/:walletId", () => {
    test("returns the wallet in the same shape as the creation", async () => {
      const created = (await (await openWallet(walletRequest(Bun.randomUUIDv7()))).json()) as WalletBody;

      const response = await fetch(`${testApp.baseUrl}/wallets/${created.id}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(created);
    });

    test("is a 404 problem for an unknown wallet and a 400 for a malformed id", async () => {
      const missing = await fetch(`${testApp.baseUrl}/wallets/${Bun.randomUUIDv7()}`);
      const malformed = await fetch(`${testApp.baseUrl}/wallets/abc`);

      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { code: string }).code).toBe("WALLET_NOT_FOUND");
      expect(malformed.status).toBe(400);
      expect(((await malformed.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
    });
  });

  describe("GET /wallets/:walletId/ledger", () => {
    test("the cursor stays stable while entries are appended, even with a skewed clock", async () => {
      const created = (await (await openWallet(walletRequest(Bun.randomUUIDv7()))).json()) as WalletBody;
      const [{ created_at: openedAt }] = await sql`SELECT created_at FROM wallets WHERE id = ${created.id}`;
      const secondsAfterOpening = (seconds: number) => new Date((openedAt as Date).getTime() + seconds * 1_000);
      for (let movement = 1; movement <= 9; movement += 1) {
        await applyTransaction(orm, created.id, WagerTransactionKind.Win, "1.00", { at: secondsAfterOpening(movement * 10) });
      }

      const first = await ledgerPage(created.id, "limit=4");
      await applyTransaction(orm, created.id, WagerTransactionKind.Win, "1.00", { at: secondsAfterOpening(200) });
      await applyTransaction(orm, created.id, WagerTransactionKind.Win, "1.00", { at: secondsAfterOpening(1) });
      await applyTransaction(orm, created.id, WagerTransactionKind.Win, "1.00", { at: secondsAfterOpening(210) });
      const second = await ledgerPage(created.id, `limit=4&cursor=${first.nextCursor}`);
      const third = await ledgerPage(created.id, `limit=4&cursor=${second.nextCursor}`);
      const fresh = await ledgerPage(created.id, "limit=3");

      const versions = (page: LedgerBody) => page.items.map((item) => item.walletVersion);
      expect(versions(first)).toEqual([10, 9, 8, 7]);
      expect(versions(second)).toEqual([6, 5, 4, 3]);
      expect(versions(third)).toEqual([2, 1]);
      expect(third.nextCursor).toBeNull();
      expect([...versions(first), ...versions(second), ...versions(third)]).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
      expect(versions(fresh)).toEqual([13, 12, 11]);
      expect(fresh.items[1]?.createdAt).toBe(secondsAfterOpening(1).toISOString());
    });

    test("an entry cannot be squeezed in the middle of the history", async () => {
      const created = (await (await openWallet(walletRequest(Bun.randomUUIDv7()))).json()) as WalletBody;
      for (let movement = 1; movement <= 5; movement += 1) {
        await applyTransaction(orm, created.id, WagerTransactionKind.Win, "1.00");
      }
      const { transaction: loss } = await applyTransaction(orm, created.id, WagerTransactionKind.Loss, "0.00");

      await expectConstraintViolation(
        sql.begin(
          (tx) => tx`
            INSERT INTO wallet_ledger_entries (id, wallet_id, wallet_version, transaction_id, direction, amount, currency,
                                               balance_before, balance_after, created_at)
            VALUES (${Bun.randomUUIDv7()}, ${created.id}, 5, ${loss.id}, 'CREDIT', 1.00, 'BRL', 0.00, 1.00, now())`,
        ),
        "wallet_ledger_entries_wallet_version_key",
      );
    });

    test("rejects a cursor from another wallet, a tampered cursor and an out-of-range limit", async () => {
      const first = (await (await openWallet(walletRequest(Bun.randomUUIDv7()))).json()) as WalletBody;
      const second = (await (await openWallet(walletRequest(Bun.randomUUIDv7()))).json()) as WalletBody;
      await applyTransaction(orm, first.id, WagerTransactionKind.Win, "1.00");
      const page = await ledgerPage(first.id, "limit=1");

      const responses = {
        foreignCursor: await fetch(`${testApp.baseUrl}/wallets/${second.id}/ledger?cursor=${page.nextCursor}`),
        tamperedCursor: await fetch(`${testApp.baseUrl}/wallets/${first.id}/ledger?cursor=abc`),
        zeroLimit: await fetch(`${testApp.baseUrl}/wallets/${first.id}/ledger?limit=0`),
        hugeLimit: await fetch(`${testApp.baseUrl}/wallets/${first.id}/ledger?limit=201`),
        unknownWallet: await fetch(`${testApp.baseUrl}/wallets/${Bun.randomUUIDv7()}/ledger`),
      };
      const codes = Object.fromEntries(
        await Promise.all(
          Object.entries(responses).map(async ([name, response]) => [
            name,
            [response.status, ((await response.json()) as { code: string }).code],
          ]),
        ),
      );

      expect(codes).toEqual({
        foreignCursor: [400, "INVALID_CURSOR"],
        tamperedCursor: [400, "INVALID_CURSOR"],
        zeroLimit: [400, "VALIDATION_FAILED"],
        hugeLimit: [400, "VALIDATION_FAILED"],
        unknownWallet: [404, "WALLET_NOT_FOUND"],
      });
    });
  });

  describe("infrastructure", () => {
    test("an unreachable database is a retryable 503", async () => {
      const unreachable = await createTestApp({ DB_PORT: "1" });
      try {
        const response = await fetch(`${unreachable.baseUrl}/wallets/${Bun.randomUUIDv7()}`);

        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("1");
        expect(await response.json()).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", retryable: true });
      } finally {
        await unreachable.app.close();
      }
    });

    test("the AuthGuard extension point protects the wallet endpoints but not health", () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, WalletsController)).toEqual([AuthGuard]);
      expect(Reflect.getMetadata(GUARDS_METADATA, HealthController)).toBeUndefined();
    });
  });
});
