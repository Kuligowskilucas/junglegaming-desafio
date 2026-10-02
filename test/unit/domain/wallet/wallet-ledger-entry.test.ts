import { describe, expect, test } from "bun:test";
import { Money } from "../../../../src/domain/shared/money";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction";
import {
  type CreateLedgerEntryProps,
  InvalidLedgerEntryError,
  WalletLedgerEntry,
} from "../../../../src/domain/wallet/wallet-ledger-entry";
import { at, brl } from "../../../support/domain-builders";

function entryProps(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: "entry-1",
    walletId: "wallet-1",
    walletVersion: 2,
    transactionId: "tx-1",
    direction: LedgerDirection.Debit,
    money: brl("25.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("75.00"),
    createdAt: at,
    ...overrides,
  };
}

describe("WalletLedgerEntry.create", () => {
  test("accepts a balanced debit", () => {
    const entry = WalletLedgerEntry.create(entryProps());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON().amount).toBe("75.00");
  });

  test("accepts a balanced credit", () => {
    const entry = WalletLedgerEntry.create(
      entryProps({ direction: LedgerDirection.Credit, balanceAfter: brl("125.00") }),
    );

    expect(entry.isBalanced()).toBe(true);
  });

  test.each([
    ["a debit that does not subtract", entryProps({ balanceAfter: brl("125.00") })],
    ["a credit that does not add", entryProps({ direction: LedgerDirection.Credit })],
    ["an off-by-one-cent balance", entryProps({ balanceAfter: brl("75.01") })],
  ])("rejects %s", (_, props) => {
    expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a zero amount", () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ money: brl("0.00"), balanceAfter: brl("100.00") })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a negative resulting balance", () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({ money: brl("25.00"), balanceBefore: brl("10.00"), balanceAfter: brl("10.00").subtract(brl("25.00")) }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test.each([0, -1, 1.5])("rejects the wallet version %p", (walletVersion) => {
    expect(() => WalletLedgerEntry.create(entryProps({ walletVersion }))).toThrow(InvalidLedgerEntryError);
  });

  test("rejects mixed currencies", () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ money: Money.from({ amount: "25.00", currency: "USD" }) })),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe("WalletLedgerEntry immutability", () => {
  test("is frozen, so its fields cannot be reassigned", () => {
    const entry = WalletLedgerEntry.create(entryProps());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { balanceAfter: Money }).balanceAfter = brl("1000.00");
    }).toThrow(TypeError);
  });

  test("hands out copies of its creation date", () => {
    const entry = WalletLedgerEntry.create(entryProps());

    entry.createdAt.setUTCFullYear(1999);

    expect(entry.createdAt.toISOString()).toBe(at.toISOString());
  });

  test("exposes no transition methods", () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => name !== "constructor",
    );

    expect(methods.sort()).toEqual(["createdAt", "isBalanced"]);
  });
});

describe("WalletLedgerEntry.rehydrate", () => {
  test("rebuilds the persisted state as is", () => {
    const entry = WalletLedgerEntry.rehydrate(entryProps());

    expect(entry.id).toBe("entry-1");
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.createdAt).toEqual(at);
  });
});
