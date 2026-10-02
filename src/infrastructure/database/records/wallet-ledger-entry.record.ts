import { defineEntity, type InferEntity, p } from "@mikro-orm/core";
import { LedgerDirection } from "../../../domain/wallet/ledger-direction";

export const WalletLedgerEntryRecord = defineEntity({
  name: "WalletLedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    walletVersion: p.bigint("number"),
    transactionId: p.uuid(),
    direction: p.enum(() => LedgerDirection),
    amount: p.decimal(),
    currency: p.string(),
    balanceBefore: p.decimal(),
    balanceAfter: p.decimal(),
    createdAt: p.datetime(),
  },
});

export type WalletLedgerEntryRecord = InferEntity<typeof WalletLedgerEntryRecord>;
