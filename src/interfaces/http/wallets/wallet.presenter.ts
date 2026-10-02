import type { MoneyProps } from "../../../domain/shared/money";
import type { LedgerDirection } from "../../../domain/wallet/ledger-direction";
import type { Wallet } from "../../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export function presentWallet(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function presentLedgerEntry(entry: WalletLedgerEntry): LedgerEntryResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}
