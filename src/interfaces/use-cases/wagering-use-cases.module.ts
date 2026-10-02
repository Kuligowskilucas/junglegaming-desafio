import { Module } from "@nestjs/common";
import { Clock } from "../../application/ports/clock";
import { IdGenerator } from "../../application/ports/id-generator";
import { OutboxRepository } from "../../application/ports/outbox-repository";
import { TransactionRunner } from "../../application/ports/transaction-runner";
import { WagerTransactionRepository } from "../../application/ports/wager-transaction-repository";
import { WalletLedgerRepository } from "../../application/ports/wallet-ledger-repository";
import { WalletRepository } from "../../application/ports/wallet-repository";
import { GetWagerTransaction } from "../../application/wagering/get-wager-transaction";
import { SettleAndRecord } from "../../application/wagering/settle-and-record";
import { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import { PersistenceModule } from "../../infrastructure/database/persistence.module";
import { SystemModule } from "../../infrastructure/system/system.module";

@Module({
  imports: [PersistenceModule, SystemModule],
  providers: [
    {
      provide: SettleAndRecord,
      inject: [WalletRepository, WagerTransactionRepository, WalletLedgerRepository, OutboxRepository, Clock, IdGenerator],
      useFactory: (
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: WalletLedgerRepository,
        outbox: OutboxRepository,
        clock: Clock,
        ids: IdGenerator,
      ) => new SettleAndRecord(wallets, transactions, ledger, outbox, clock, ids),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [WalletRepository, WagerTransactionRepository, SettleAndRecord, TransactionRunner, Clock, IdGenerator],
      useFactory: (
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        settleAndRecord: SettleAndRecord,
        transactionRunner: TransactionRunner,
        clock: Clock,
        ids: IdGenerator,
      ) => new SubmitWagerTransaction(wallets, transactions, settleAndRecord, transactionRunner, clock, ids),
    },
    {
      provide: GetWagerTransaction,
      inject: [WagerTransactionRepository],
      useFactory: (transactions: WagerTransactionRepository) => new GetWagerTransaction(transactions),
    },
  ],
  exports: [SettleAndRecord, SubmitWagerTransaction, GetWagerTransaction],
})
export class WageringUseCasesModule {}
