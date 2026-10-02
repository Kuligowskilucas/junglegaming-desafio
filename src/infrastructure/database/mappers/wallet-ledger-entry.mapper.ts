import { Money } from "../../../domain/shared/money";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import type { WalletLedgerEntryRecord } from "../records/wallet-ledger-entry.record";

export const walletLedgerEntryMapper = {
  toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      walletVersion: record.walletVersion,
      transactionId: record.transactionId,
      direction: record.direction,
      money: money(record.amount),
      balanceBefore: money(record.balanceBefore),
      balanceAfter: money(record.balanceAfter),
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      walletVersion: entry.walletVersion,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    };
  },
};
