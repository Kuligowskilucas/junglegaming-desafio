import { InvalidOperationError } from "../shared/domain-error";
import type { Money, MoneyProps } from "../shared/money";

export interface WalletReconciliationInput {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface WalletReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class WalletReconciliation {
  private constructor(
    readonly walletId: string,
    readonly storedBalance: Money,
    readonly calculatedBalance: Money,
    readonly difference: Money,
    readonly checkedEntries: number,
  ) {
    Object.freeze(this);
  }

  static compare(input: WalletReconciliationInput): WalletReconciliation {
    if (!Number.isSafeInteger(input.checkedEntries) || input.checkedEntries < 0) {
      throw new InvalidOperationError(
        `Reconciliation of wallet ${input.walletId} needs a non-negative entry count, got ${input.checkedEntries}`,
      );
    }
    return new WalletReconciliation(
      input.walletId,
      input.storedBalance,
      input.calculatedBalance,
      input.storedBalance.subtract(input.calculatedBalance),
      input.checkedEntries,
    );
  }

  get consistent(): boolean {
    return this.difference.isZero();
  }

  toJSON(): WalletReconciliationView {
    return {
      walletId: this.walletId,
      storedBalance: this.storedBalance.toJSON(),
      calculatedBalance: this.calculatedBalance.toJSON(),
      difference: this.difference.toJSON(),
      consistent: this.consistent,
      checkedEntries: this.checkedEntries,
    };
  }
}
