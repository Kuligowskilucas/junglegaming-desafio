import type { Money } from "../../domain/shared/money";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export interface LedgerPageRequest {
  beforeWalletVersion: number | undefined;
  limit: number;
}

export interface LedgerSummary {
  balance: Money;
  entries: number;
}

export abstract class WalletLedgerRepository {
  abstract append(entry: WalletLedgerEntry): Promise<void>;
  abstract listByWallet(walletId: string, page: LedgerPageRequest): Promise<WalletLedgerEntry[]>;
  abstract summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}
