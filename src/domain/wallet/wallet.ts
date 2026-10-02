import { InvalidOperationError, InvariantViolationError } from "../shared/domain-error";
import { CurrencyMismatchError, Money } from "../shared/money";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | undefined;
}

export interface LedgerMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class InsufficientBalanceError extends InvariantViolationError {
  constructor(walletId: string, balance: Money, requested: Money) {
    super(`Wallet ${walletId} cannot debit ${requested.toString()} from balance ${balance.toString()}`);
  }
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  private _balance: Money;
  private _version: number;
  private readonly createdAtTime: number;
  private updatedAtTime: number;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this._balance = state.balance;
    this._version = state.version;
    this.createdAtTime = state.createdAt.getTime();
    this.updatedAtTime = state.updatedAt.getTime();
  }

  static open(props: OpenWalletProps): OpenedWallet {
    const { id, playerId, initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidOperationError(`Wallet ${id} cannot open with a negative balance`);
    }
    const wallet = new Wallet({
      id,
      playerId,
      currency: initialBalance.currency,
      balance: initialBalance,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    const openingEntry = initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: id,
          walletVersion: 1,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          createdAt: at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this.createdAtTime);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtTime);
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: LedgerMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientBalanceError(this.id, this._balance, movement.money);
    }
    return this.apply(LedgerDirection.Debit, movement, this._balance.subtract(movement.money));
  }

  credit(movement: LedgerMovement): WalletLedgerEntry {
    this.assertMovement(movement.money);
    return this.apply(LedgerDirection.Credit, movement, this._balance.add(movement.money));
  }

  private apply(direction: LedgerDirection, movement: LedgerMovement, balanceAfter: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      walletVersion: this._version + 1,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this.updatedAtTime = movement.at.getTime();
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidOperationError(`Wallet ${this.id} only moves positive amounts, got ${money.toString()}`);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
