import { Module } from "@nestjs/common";
import { Clock } from "../../../application/ports/clock";
import { IdGenerator } from "../../../application/ports/id-generator";
import { OutboxRepository } from "../../../application/ports/outbox-repository";
import { TransactionRunner } from "../../../application/ports/transaction-runner";
import { WagerTransactionRepository } from "../../../application/ports/wager-transaction-repository";
import { WalletLedgerRepository } from "../../../application/ports/wallet-ledger-repository";
import { WalletRepository } from "../../../application/ports/wallet-repository";
import { GetWallet } from "../../../application/wallet/get-wallet";
import { ListWalletLedger } from "../../../application/wallet/list-wallet-ledger";
import { OpenWallet } from "../../../application/wallet/open-wallet";
import { ReconcileWallet } from "../../../application/wallet/reconcile-wallet";
import { PersistenceModule } from "../../../infrastructure/database/persistence.module";
import { SystemModule } from "../../../infrastructure/system/system.module";
import { AuthGuard } from "../auth/auth.guard";
import { WalletsController } from "./wallets.controller";

@Module({
  imports: [PersistenceModule, SystemModule],
  controllers: [WalletsController],
  providers: [
    AuthGuard,
    {
      provide: OpenWallet,
      inject: [
        WalletRepository,
        WagerTransactionRepository,
        WalletLedgerRepository,
        OutboxRepository,
        TransactionRunner,
        Clock,
        IdGenerator,
      ],
      useFactory: (
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: WalletLedgerRepository,
        outbox: OutboxRepository,
        transactionRunner: TransactionRunner,
        clock: Clock,
        ids: IdGenerator,
      ) => new OpenWallet(wallets, transactions, ledger, outbox, transactionRunner, clock, ids),
    },
    {
      provide: GetWallet,
      inject: [WalletRepository],
      useFactory: (wallets: WalletRepository) => new GetWallet(wallets),
    },
    {
      provide: ListWalletLedger,
      inject: [WalletRepository, WalletLedgerRepository],
      useFactory: (wallets: WalletRepository, ledger: WalletLedgerRepository) => new ListWalletLedger(wallets, ledger),
    },
    {
      provide: ReconcileWallet,
      inject: [WalletRepository, WalletLedgerRepository, TransactionRunner],
      useFactory: (wallets: WalletRepository, ledger: WalletLedgerRepository, transactionRunner: TransactionRunner) =>
        new ReconcileWallet(wallets, ledger, transactionRunner),
    },
  ],
})
export class WalletsModule {}
