import { InvariantViolationError } from "../shared/domain-error";
import type { Money } from "../shared/money";
import { LedgerDirection } from "./ledger-direction";

export interface LedgerEntryState {
  id: string;
  walletId: string;
  walletVersion: number;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class InvalidLedgerEntryError extends InvariantViolationError {
  constructor(entryId: string, reason: string) {
    super(`Ledger entry ${entryId} is invalid: ${reason}`);
  }
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly walletVersion: number;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  private readonly createdAtTime: number;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.walletVersion = state.walletVersion;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.createdAtTime = state.createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { id, money, balanceBefore, balanceAfter, walletVersion } = props;
    if (!Number.isSafeInteger(walletVersion) || walletVersion < 1) {
      throw new InvalidLedgerEntryError(id, "walletVersion must be a positive integer");
    }
    if (balanceBefore.currency !== money.currency || balanceAfter.currency !== money.currency) {
      throw new InvalidLedgerEntryError(id, "money and balances must share the same currency");
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError(id, "money must be positive");
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError(id, "balances must not be negative");
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(id, "balanceBefore ± money must equal balanceAfter");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.createdAtTime);
  }

  isBalanced(): boolean {
    const signedMoney = this.direction === LedgerDirection.Debit ? this.money.negate() : this.money;
    return this.balanceBefore.add(signedMoney).equals(this.balanceAfter);
  }
}
