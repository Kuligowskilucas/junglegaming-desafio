import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { WalletNotFoundError } from "../errors";
import type { WalletLedgerRepository } from "../ports/wallet-ledger-repository";
import type { WalletRepository } from "../ports/wallet-repository";

export interface ListWalletLedgerQuery {
  walletId: string;
  beforeWalletVersion: number | undefined;
  limit: number;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextBeforeWalletVersion: number | undefined;
}

export class ListWalletLedger {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedgerRepository,
  ) {}

  async execute(query: ListWalletLedgerQuery): Promise<LedgerPage> {
    if (!(await this.wallets.findById(query.walletId))) {
      throw new WalletNotFoundError(query.walletId);
    }
    const rows = await this.ledger.listByWallet(query.walletId, {
      beforeWalletVersion: query.beforeWalletVersion,
      limit: query.limit + 1,
    });
    const entries = rows.slice(0, query.limit);
    return {
      entries,
      nextBeforeWalletVersion: rows.length > query.limit ? entries.at(-1)?.walletVersion : undefined,
    };
  }
}
