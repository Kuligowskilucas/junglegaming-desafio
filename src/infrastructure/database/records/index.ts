import { InboxMessageRecord } from "./inbox-message.record";
import { OutboxMessageRecord } from "./outbox-message.record";
import { WagerTransactionRecord } from "./wager-transaction.record";
import { WalletLedgerEntryRecord } from "./wallet-ledger-entry.record";
import { WalletRecord } from "./wallet.record";

export const persistenceRecords = [
  WalletRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  InboxMessageRecord,
  OutboxMessageRecord,
];
