import { Module } from "@nestjs/common";
import { OutboxRepository } from "../../application/ports/outbox-repository";
import { TransactionRunner } from "../../application/ports/transaction-runner";
import { WagerTransactionRepository } from "../../application/ports/wager-transaction-repository";
import { WalletLedgerRepository } from "../../application/ports/wallet-ledger-repository";
import { WalletRepository } from "../../application/ports/wallet-repository";
import { DatabaseModule } from "./database.module";
import { MikroOrmOutboxRepository } from "./repositories/mikro-orm-outbox.repository";
import { MikroOrmTransactionRunner } from "./repositories/mikro-orm-transaction-runner";
import { MikroOrmWagerTransactionRepository } from "./repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletLedgerRepository } from "./repositories/mikro-orm-wallet-ledger.repository";
import { MikroOrmWalletRepository } from "./repositories/mikro-orm-wallet.repository";

const ports = [
  { provide: WalletRepository, useClass: MikroOrmWalletRepository },
  { provide: WagerTransactionRepository, useClass: MikroOrmWagerTransactionRepository },
  { provide: WalletLedgerRepository, useClass: MikroOrmWalletLedgerRepository },
  { provide: OutboxRepository, useClass: MikroOrmOutboxRepository },
  { provide: TransactionRunner, useClass: MikroOrmTransactionRunner },
];

@Module({
  imports: [DatabaseModule],
  providers: ports,
  exports: ports.map((port) => port.provide),
})
export class PersistenceModule {}
