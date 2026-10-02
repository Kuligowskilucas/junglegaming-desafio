import { Module } from "@nestjs/common";
import { HandleWagerTransactionRequested } from "../../application/messaging/handle-wager-transaction-requested";
import { Clock } from "../../application/ports/clock";
import { InboxRepository } from "../../application/ports/inbox-repository";
import { TransactionRunner } from "../../application/ports/transaction-runner";
import { SubmitWagerTransaction } from "../../application/wagering/submit-wager-transaction";
import { PersistenceModule } from "../../infrastructure/database/persistence.module";
import { MessagingModule } from "../../infrastructure/messaging/messaging.module";
import { SystemModule } from "../../infrastructure/system/system.module";
import { WageringUseCasesModule } from "../use-cases/wagering-use-cases.module";
import { WagerTransactionConsumer } from "./wager-transaction.consumer";

@Module({
  imports: [PersistenceModule, SystemModule, MessagingModule, WageringUseCasesModule],
  providers: [
    {
      provide: HandleWagerTransactionRequested,
      inject: [InboxRepository, SubmitWagerTransaction, TransactionRunner, Clock],
      useFactory: (
        inbox: InboxRepository,
        submitWagerTransaction: SubmitWagerTransaction,
        transactionRunner: TransactionRunner,
        clock: Clock,
      ) => new HandleWagerTransactionRequested(inbox, submitWagerTransaction, transactionRunner, clock),
    },
    WagerTransactionConsumer,
  ],
  exports: [HandleWagerTransactionRequested, WagerTransactionConsumer],
})
export class SqsConsumerModule {}
