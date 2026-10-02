import { Module } from "@nestjs/common";
import { Clock } from "../../application/ports/clock";
import { IdGenerator } from "../../application/ports/id-generator";
import { OutboxRepository } from "../../application/ports/outbox-repository";
import { TransactionRunner } from "../../application/ports/transaction-runner";
import { WagerTransactionRepository } from "../../application/ports/wager-transaction-repository";
import { WalletLedgerRepository } from "../../application/ports/wallet-ledger-repository";
import { WalletRepository } from "../../application/ports/wallet-repository";
import { GetWagerTransaction } from "../../application/wagering/get-wager-transaction";
import { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import { PersistenceModule } from "../../infrastructure/database/persistence.module";
import { SystemModule } from "../../infrastructure/system/system.module";

@Module({
  imports: [PersistenceModule, SystemModule],
  providers: [
    {
      provide: SubmitWagerTransaction,
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
      ) => new SubmitWagerTransaction(wallets, transactions, ledger, outbox, transactionRunner, clock, ids),
    },
    {
      provide: GetWagerTransaction,
      inject: [WagerTransactionRepository],
      useFactory: (transactions: WagerTransactionRepository) => new GetWagerTransaction(transactions),
    },
  ],
  exports: [SubmitWagerTransaction, GetWagerTransaction],
})
export class WageringUseCasesModule {}
