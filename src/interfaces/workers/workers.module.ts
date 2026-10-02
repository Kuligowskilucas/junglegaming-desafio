import { Module } from "@nestjs/common";
import { PublishPendingEvents } from "../../application/messaging/publish-pending-events";
import { Clock } from "../../application/ports/clock";
import { EventPublisher } from "../../application/ports/event-publisher";
import { OutboxRepository } from "../../application/ports/outbox-repository";
import { TransactionRunner } from "../../application/ports/transaction-runner";
import { WagerTransactionRepository } from "../../application/ports/wager-transaction-repository";
import { WalletRepository } from "../../application/ports/wallet-repository";
import { RetryPendingReferences } from "../../application/wagering/retry-pending-references";
import { SettleAndRecord } from "../../application/wagering/settle-and-record";
import { AppConfig } from "../../infrastructure/config/app-config";
import { PersistenceModule } from "../../infrastructure/database/persistence.module";
import { MessagingModule } from "../../infrastructure/messaging/messaging.module";
import { SystemModule } from "../../infrastructure/system/system.module";
import { WageringUseCasesModule } from "../use-cases/wagering-use-cases.module";
import { OutboxPublisherWorker } from "./outbox-publisher.worker";
import { PendingReferenceWorker } from "./pending-reference.worker";

@Module({
  imports: [PersistenceModule, SystemModule, MessagingModule, WageringUseCasesModule],
  providers: [
    {
      provide: PublishPendingEvents,
      inject: [OutboxRepository, EventPublisher, TransactionRunner, Clock, AppConfig],
      useFactory: (
        outbox: OutboxRepository,
        publisher: EventPublisher,
        transactionRunner: TransactionRunner,
        clock: Clock,
        config: AppConfig,
      ) =>
        new PublishPendingEvents(outbox, publisher, transactionRunner, clock, {
          orderingKeys: config.outbox.batchOrderingKeys,
          messagesPerOrderingKey: config.outbox.batchMessagesPerOrderingKey,
        }),
    },
    {
      provide: RetryPendingReferences,
      inject: [WalletRepository, WagerTransactionRepository, SettleAndRecord, TransactionRunner, Clock, AppConfig],
      useFactory: (
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        settleAndRecord: SettleAndRecord,
        transactionRunner: TransactionRunner,
        clock: Clock,
        config: AppConfig,
      ) =>
        new RetryPendingReferences(
          wallets,
          transactions,
          settleAndRecord,
          transactionRunner,
          clock,
          config.referenceWorker.batchSize,
        ),
    },
    OutboxPublisherWorker,
    PendingReferenceWorker,
  ],
  exports: [OutboxPublisherWorker, PendingReferenceWorker],
})
export class WorkersModule {}
