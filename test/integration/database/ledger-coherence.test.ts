import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status";
import type { WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import type { Wallet } from "../../../src/domain/wallet/wallet";
import { connectSql, expectConstraintViolation, initOrm, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { applyTransaction, openWallet } from "../../support/persistence";

useIntegrationEnvironment();

const { Bet, Win, Refund } = WagerTransactionKind;

interface Movement {
  wallet: Wallet;
  fromVersion: number;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  before: string;
  after: string;
  kind: string;
  status?: "PROCESSED" | "REJECTED";
  transactionAmount?: string;
  transactionCurrency?: string;
  reference?: WagerTransaction;
  updateWallet?: boolean;
}

describe("deferred coherence between wallet, ledger and transaction", () => {
  let orm: MikroORM;
  let sql: SQL;

  beforeAll(async () => {
    await resetDatabase();
    orm = await initOrm();
    sql = connectSql();
  });

  afterAll(async () => {
    await sql.close();
    await orm.close();
  });

  function commitMovement(movement: Movement): Promise<unknown> {
    const transactionId = Bun.randomUUIDv7();
    const externalId = `${movement.kind.toLowerCase()}-${transactionId}`;
    const status = movement.status ?? "PROCESSED";
    const version = movement.fromVersion + 1;
    const reference = movement.reference;
    return sql.begin(async (tx) => {
      await tx`
        INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
          game_id, kind, amount, currency, reference_external_transaction_id, status, reference_transaction_id,
          failure_code, observed_balance, reference_attempts, next_reference_attempt_at, created_at, updated_at,
          processed_at
        ) VALUES (
          ${transactionId}, 'provider-a', ${externalId}, ${`provider-a:${externalId}`}, ${"b".repeat(64)},
          ${movement.wallet.id}, ${movement.wallet.playerId}, ${reference?.roundId ?? "round-1"}, 'fortune-chimp',
          ${movement.kind}, ${movement.transactionAmount ?? movement.amount}, ${movement.transactionCurrency ?? "BRL"},
          ${reference?.externalTransactionId ?? null}, ${status},
          ${status === "PROCESSED" ? (reference?.id ?? null) : null},
          ${status === "REJECTED" ? "INSUFFICIENT_FUNDS" : null}, ${movement.after}, 0, NULL, now(), now(),
          ${status === "PROCESSED" ? new Date() : null}
        )`;
      await tx`
        INSERT INTO wallet_ledger_entries (
          id, wallet_id, wallet_version, transaction_id, direction, amount, currency, balance_before, balance_after,
          created_at
        ) VALUES (
          ${Bun.randomUUIDv7()}, ${movement.wallet.id}, ${version}, ${transactionId}, ${movement.direction},
          ${movement.amount}, 'BRL', ${movement.before}, ${movement.after}, now()
        )`;
      if (movement.updateWallet ?? true) {
        await tx`
          UPDATE wallets SET balance = ${movement.after}, version = ${version}, updated_at = now()
           WHERE id = ${movement.wallet.id}`;
      }
    });
  }

  async function processed(walletId: string, kind: WagerTransactionKind, amount: string, reference?: WagerTransaction) {
    const applied = await applyTransaction(orm, walletId, kind, amount, { reference });
    expect(applied.outcome.status).toBe(WagerTransactionStatus.Processed);
    return applied.transaction;
  }

  async function expectDirectionRejected(movement: Movement, expected: string, received: string, describedAs: string) {
    const error = await expectConstraintViolation(commitMovement(movement), "wallet_ledger_entries_match_transaction");
    expect(error.message).toContain(`(${describedAs}`);
    expect(error.message).toContain(`has direction ${received}, expected ${expected}`);
    expect((error as { detail?: string }).detail).toContain(`expected_direction=${expected} received_direction=${received}`);
    expect((error as { detail?: string }).detail).toContain(`wallet_id=${movement.wallet.id}`);
  }

  describe("ROLLBACK direction is the inverse of the reference", () => {
    test("ROLLBACK of BET: CREDIT commits", async () => {
      const wallet = await openWallet(orm, "100.00");
      const bet = await processed(wallet.id, Bet, "10.00");

      await commitMovement({ wallet, fromVersion: 2, kind: "ROLLBACK", reference: bet, direction: "CREDIT", amount: "10.00", before: "90.00", after: "100.00" });

      const [row] = await sql`SELECT balance::text, version FROM wallets WHERE id = ${wallet.id}`;
      expect(row).toEqual({ balance: "100.00", version: "3" });
    });

    test("ROLLBACK of BET: DEBIT is refused at commit", async () => {
      const wallet = await openWallet(orm, "100.00");
      const bet = await processed(wallet.id, Bet, "10.00");

      await expectDirectionRejected(
        { wallet, fromVersion: 2, kind: "ROLLBACK", reference: bet, direction: "DEBIT", amount: "10.00", before: "90.00", after: "80.00" },
        "CREDIT",
        "DEBIT",
        `ROLLBACK of BET ${bet.id}`,
      );
    });

    test("ROLLBACK of WIN: DEBIT commits", async () => {
      const wallet = await openWallet(orm, "100.00");
      const win = await processed(wallet.id, Win, "30.00");

      await commitMovement({ wallet, fromVersion: 2, kind: "ROLLBACK", reference: win, direction: "DEBIT", amount: "30.00", before: "130.00", after: "100.00" });
    });

    test("ROLLBACK of WIN: CREDIT is refused at commit", async () => {
      const wallet = await openWallet(orm, "100.00");
      const win = await processed(wallet.id, Win, "30.00");

      await expectDirectionRejected(
        { wallet, fromVersion: 2, kind: "ROLLBACK", reference: win, direction: "CREDIT", amount: "30.00", before: "130.00", after: "160.00" },
        "DEBIT",
        "CREDIT",
        `ROLLBACK of WIN ${win.id}`,
      );
    });

    test("ROLLBACK of REFUND: DEBIT commits", async () => {
      const wallet = await openWallet(orm, "100.00");
      const bet = await processed(wallet.id, Bet, "10.00");
      const refund = await processed(wallet.id, Refund, "10.00", bet);

      await commitMovement({ wallet, fromVersion: 3, kind: "ROLLBACK", reference: refund, direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00" });
    });

    test("ROLLBACK of REFUND: CREDIT is refused at commit", async () => {
      const wallet = await openWallet(orm, "100.00");
      const bet = await processed(wallet.id, Bet, "10.00");
      const refund = await processed(wallet.id, Refund, "10.00", bet);

      await expectDirectionRejected(
        { wallet, fromVersion: 3, kind: "ROLLBACK", reference: refund, direction: "CREDIT", amount: "10.00", before: "100.00", after: "110.00" },
        "DEBIT",
        "CREDIT",
        `ROLLBACK of REFUND ${refund.id}`,
      );
    });
  });

  describe("other kinds", () => {
    test("BET recorded as CREDIT is refused", async () => {
      const wallet = await openWallet(orm, "100.00");

      await expectDirectionRejected(
        { wallet, fromVersion: 1, kind: "BET", direction: "CREDIT", amount: "10.00", before: "100.00", after: "110.00" },
        "DEBIT",
        "CREDIT",
        "BET",
      );
    });

    test("WIN recorded as DEBIT is refused", async () => {
      const wallet = await openWallet(orm, "100.00");

      await expectDirectionRejected(
        { wallet, fromVersion: 1, kind: "WIN", direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00" },
        "CREDIT",
        "DEBIT",
        "WIN",
      );
    });

    test("a REJECTED transaction cannot have a ledger entry", async () => {
      const wallet = await openWallet(orm, "100.00");

      const error = await expectConstraintViolation(
        commitMovement({ wallet, fromVersion: 1, kind: "BET", status: "REJECTED", direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00" }),
        "wallet_ledger_entries_match_transaction",
      );
      expect(error.message).toContain("requires a PROCESSED transaction, got REJECTED");
    });

    test("a LOSS cannot have a ledger entry", async () => {
      const wallet = await openWallet(orm, "100.00");

      const error = await expectConstraintViolation(
        commitMovement({ wallet, fromVersion: 1, kind: "LOSS", direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00" }),
        "wallet_ledger_entries_match_transaction",
      );
      expect(error.message).toContain("LOSS never moves balance");
    });

    test("the entry must move the transaction amount", async () => {
      const wallet = await openWallet(orm, "100.00");

      const error = await expectConstraintViolation(
        commitMovement({ wallet, fromVersion: 1, kind: "BET", transactionAmount: "15.00", direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00" }),
        "wallet_ledger_entries_match_transaction",
      );
      expect(error.message).toContain("moves 10.00 BRL, expected 15.00 BRL");
    });

    test("the entry must move the transaction currency", async () => {
      const wallet = await openWallet(orm, "100.00");

      const error = await expectConstraintViolation(
        commitMovement({ wallet, fromVersion: 1, kind: "WIN", transactionCurrency: "USD", direction: "CREDIT", amount: "10.00", before: "100.00", after: "110.00" }),
        "wallet_ledger_entries_match_transaction",
      );
      expect(error.message).toContain("moves 10.00 BRL, expected 10.00 USD");
    });
  });

  describe("wallet and ledger stay in step", () => {
    test("changing the balance without a ledger entry is refused at commit", async () => {
      const wallet = await openWallet(orm, "100.00");

      const error = await expectConstraintViolation(
        sql.begin((tx) => tx`UPDATE wallets SET balance = 105.00, version = 2 WHERE id = ${wallet.id}`),
        "wallets_balance_matches_ledger",
      );
      expect(error.message).toContain(`wallet ${wallet.id} at version 2 has balance 105.00`);
      expect((error as { detail?: string }).detail).toContain("latest_entry_version=1 latest_entry_balance_after=100.00");
    });

    test("an entry that does not start where the previous one ended is refused", async () => {
      const wallet = await openWallet(orm, "100.00");

      const error = await expectConstraintViolation(
        commitMovement({ wallet, fromVersion: 1, kind: "BET", direction: "DEBIT", amount: "10.00", before: "95.00", after: "85.00" }),
        "wallet_ledger_entries_chained",
      );
      expect(error.message).toContain("at wallet_version 2 starts at 95.00 but the previous entry ends at 100.00");
    });

    test("an entry ahead of the wallet version is refused", async () => {
      const wallet = await openWallet(orm, "100.00");

      const error = await expectConstraintViolation(
        commitMovement({ wallet, fromVersion: 1, kind: "BET", direction: "DEBIT", amount: "10.00", before: "100.00", after: "90.00", updateWallet: false }),
        "wallet_ledger_entries_chained",
      );
      expect(error.message).toContain(`but wallet ${wallet.id} is still at version 1`);
    });

    test("a wallet opened empty starts its ledger at wallet_version 2", async () => {
      const wallet = await openWallet(orm, "0.00");

      await processed(wallet.id, Win, "10.00");

      const rows = await sql`
        SELECT wallet_version, balance_before::text, balance_after::text FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id}`;
      expect(rows).toEqual([{ wallet_version: "2", balance_before: "0.00", balance_after: "10.00" }]);
    });
  });
});
