import { describe, expect, test } from "bun:test";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error";
import { CurrencyMismatchError, Money } from "../../../../src/domain/shared/money";
import { WalletReconciliation } from "../../../../src/domain/wallet/wallet-reconciliation";
import { brl } from "../../../support/domain-builders";

function reconcile(stored: Money, calculated: Money, checkedEntries = 3) {
  return WalletReconciliation.compare({ walletId: "wallet-1", storedBalance: stored, calculatedBalance: calculated, checkedEntries });
}

describe("WalletReconciliation.compare", () => {
  test("is consistent when the stored balance equals the balance rebuilt from the ledger", () => {
    expect(reconcile(brl("975.00"), brl("975.00"), 42).toJSON()).toEqual({
      walletId: "wallet-1",
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 42,
    });
  });

  test("reports a positive difference when the stored balance has no backing in the ledger", () => {
    const reconciliation = reconcile(brl("105.00"), brl("100.00"));

    expect(reconciliation.consistent).toBe(false);
    expect(reconciliation.difference.toJSON()).toEqual({ amount: "5.00", currency: "BRL" });
  });

  test("reports a negative difference when the ledger adds up to more than the stored balance", () => {
    expect(reconcile(brl("99.99"), brl("100.00")).difference.toJSON()).toEqual({ amount: "-0.01", currency: "BRL" });
  });

  test("accepts a negative rebuilt balance, which only a corrupted ledger can produce", () => {
    const reconciliation = reconcile(brl("0.00"), brl("10.00").negate());

    expect(reconciliation.toJSON()).toMatchObject({
      calculatedBalance: { amount: "-10.00", currency: "BRL" },
      difference: { amount: "10.00", currency: "BRL" },
      consistent: false,
    });
  });

  test("a wallet without entries is consistent at zero", () => {
    expect(reconcile(brl("0.00"), Money.zero("BRL"), 0).toJSON()).toMatchObject({ consistent: true, checkedEntries: 0 });
  });

  test("refuses balances in different currencies", () => {
    expect(() => reconcile(brl("10.00"), Money.from({ amount: "10.00", currency: "USD" }))).toThrow(CurrencyMismatchError);
  });

  test.each([-1, 1.5, Number.NaN])("refuses an entry count of %p", (checkedEntries) => {
    expect(() => reconcile(brl("10.00"), brl("10.00"), checkedEntries)).toThrow(InvalidOperationError);
  });

  test("is immutable", () => {
    expect(Object.isFrozen(reconcile(brl("10.00"), brl("10.00")))).toBe(true);
  });
});
