import { WalletReconciliation } from "../../domain/wallet/wallet-reconciliation";
import { WalletNotFoundError } from "../errors";
import type { TransactionRunner } from "../ports/transaction-runner";
import type { WalletLedgerRepository } from "../ports/wallet-ledger-repository";
import type { WalletRepository } from "../ports/wallet-repository";

export class ReconcileWallet {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly transactionRunner: TransactionRunner,
  ) {}

  execute(walletId: string): Promise<WalletReconciliation> {
    return this.transactionRunner.readSnapshot(async () => {
      const wallet = await this.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      const ledger = await this.ledger.summarize(wallet.id, wallet.currency);
      return WalletReconciliation.compare({
        walletId: wallet.id,
        storedBalance: wallet.balance,
        calculatedBalance: ledger.balance,
        checkedEntries: ledger.entries,
      });
    });
  }
}
