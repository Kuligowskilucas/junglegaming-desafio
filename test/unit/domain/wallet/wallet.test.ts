import { describe, expect, test } from "bun:test";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error";
import { CurrencyMismatchError, Money } from "../../../../src/domain/shared/money";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction";
import { InsufficientBalanceError, Wallet } from "../../../../src/domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../../../src/domain/wallet/wallet-ledger-entry";
import { at, aWallet, brl, secondsAfter } from "../../../support/domain-builders";
import { randomInt, seededRandom } from "../../../support/seeded-random";

function movement(amount: string, sequence = 1) {
  return {
    entryId: `entry-${sequence}`,
    transactionId: `tx-${sequence}`,
    money: brl(amount),
    at: secondsAfter(sequence),
  };
}

function openWallet(initialBalance: string) {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initialBalance),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    at,
  });
}

describe("Wallet.open", () => {
  test("starts at version 1 with the opening credit in the ledger", () => {
    const { wallet, openingEntry } = openWallet("1000.00");

    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe("tx-opening");
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test("opens an empty wallet at version 1 without any ledger entry", () => {
    const { wallet, openingEntry } = openWallet("0.00");

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test("refuses a negative initial balance", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: brl("0.00").subtract(brl("1.00")),
        openingTransactionId: "tx-opening",
        openingEntryId: "entry-opening",
        at,
      }),
    ).toThrow(InvalidOperationError);
  });
});

describe("Wallet.credit and Wallet.debit", () => {
  test("credit raises the balance, bumps the version and returns the matching entry", () => {
    const wallet = aWallet({ balance: brl("100.00") });

    const entry = wallet.credit(movement("25.50"));

    expect(wallet.balance.toJSON().amount).toBe("125.50");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(secondsAfter(1));
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe("tx-1");
    expect(entry.id).toBe("entry-1");
  });

  test("debit lowers the balance and returns the matching entry", () => {
    const wallet = aWallet({ balance: brl("100.00") });

    const entry = wallet.debit(movement("80.00"));

    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
  });

  test("debit may take the balance exactly to zero", () => {
    const wallet = aWallet({ balance: brl("80.00") });

    wallet.debit(movement("80.00"));

    expect(wallet.balance.isZero()).toBe(true);
  });

  test("debit beyond the balance throws and leaves the wallet untouched", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    wallet.debit(movement("80.00", 1));

    expect(() => wallet.debit(movement("80.00", 2))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("canDebit answers without changing the wallet", () => {
    const wallet = aWallet({ balance: brl("100.00") });

    expect(wallet.canDebit(brl("100.00"))).toBe(true);
    expect(wallet.canDebit(brl("100.01"))).toBe(false);
    expect(wallet.version).toBe(1);
  });

  test.each([
    ["credit", (wallet: Wallet, money: Money) => wallet.credit({ ...movement("1.00"), money })],
    ["debit", (wallet: Wallet, money: Money) => wallet.debit({ ...movement("1.00"), money })],
    ["canDebit", (wallet: Wallet, money: Money) => wallet.canDebit(money)],
  ])("%s in another currency throws CurrencyMismatchError", (_, operation) => {
    const wallet = aWallet({ balance: brl("100.00") });

    expect(() => operation(wallet, Money.from({ amount: "1.00", currency: "USD" }))).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test.each(["credit", "debit"] as const)("%s refuses a zero amount", (operation) => {
    const wallet = aWallet();

    expect(() => wallet[operation](movement("0.00"))).toThrow(InvalidOperationError);
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet.rehydrate", () => {
  test("rebuilds the persisted state without touching the version", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-9",
      playerId: "player-9",
      currency: "BRL",
      balance: brl("975.00"),
      version: 42,
      createdAt: at,
      updatedAt: secondsAfter(60),
    });

    expect(wallet.version).toBe(42);
    expect(wallet.balance.toJSON().amount).toBe("975.00");
    expect(wallet.updatedAt).toEqual(secondsAfter(60));
  });

  test("hands out copies of its dates", () => {
    const wallet = aWallet();

    wallet.updatedAt.setUTCFullYear(1999);

    expect(wallet.updatedAt).toEqual(at);
  });
});

describe("Wallet ledger invariant", () => {
  test("balance and version always match the ledger across 1000 random movements", () => {
    const random = seededRandom(20260101);
    const { wallet, openingEntry } = openWallet("500.00");
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
    let refusedDebits = 0;

    for (let sequence = 1; sequence <= 1000; sequence += 1) {
      const cents = randomInt(random, 1, 30_000);
      const money = brl(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
      const move = { ...movement("1.00", sequence), money };
      if (random() < 0.4) {
        entries.push(wallet.credit(move));
      } else if (wallet.canDebit(money)) {
        entries.push(wallet.debit(move));
      } else {
        refusedDebits += 1;
        expect(() => wallet.debit(move)).toThrow(InsufficientBalanceError);
      }
      expect(wallet.balance.isNegative()).toBe(false);
    }

    const rebuilt = entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit ? balance.add(entry.money) : balance.subtract(entry.money),
      Money.zero("BRL"),
    );
    const entriesAfterOpening = entries.filter((entry) => entry !== openingEntry);

    expect(refusedDebits).toBeGreaterThan(0);
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(entries.every((entry) => entry.isBalanced())).toBe(true);
    entries.slice(1).forEach((entry, index) => {
      expect(entry.balanceBefore.equals(entries[index]!.balanceAfter)).toBe(true);
    });
    expect(wallet.version).toBe(1 + entriesAfterOpening.length);
  });
});
