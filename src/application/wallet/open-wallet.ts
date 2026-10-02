import type { EventContext } from "../../domain/events/event-context";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/shared/money";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { WalletAlreadyExistsError } from "../errors";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { OutboxRepository } from "../ports/outbox-repository";
import type { TransactionRunner } from "../ports/transaction-runner";
import type { WagerTransactionRepository } from "../ports/wager-transaction-repository";
import type { WalletLedgerRepository } from "../ports/wallet-ledger-repository";
import type { WalletRepository } from "../ports/wallet-repository";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export class OpenWallet {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly transactionRunner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    try {
      return await this.transactionRunner.run(async () => {
        const { wallet, openingEntry } = Wallet.open({
          id: this.ids.next(),
          playerId: command.playerId,
          initialBalance,
          openingTransactionId: this.ids.next(),
          openingEntryId: this.ids.next(),
          at,
        });
        await this.wallets.add(wallet);
        if (openingEntry) {
          await this.recordOpening(wallet, openingEntry, command.correlationId, at);
        }
        return wallet;
      });
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw error.withExistingWalletId(
          await this.wallets.findIdByPlayerAndCurrency(command.playerId, initialBalance.currency),
        );
      }
      throw error;
    }
  }

  private async recordOpening(
    wallet: Wallet,
    openingEntry: WalletLedgerEntry,
    correlationId: string,
    at: Date,
  ): Promise<void> {
    const opening = WagerTransaction.opening({
      id: openingEntry.transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: openingEntry.money,
      correlationId,
      at,
    });
    await this.transactions.add(opening);
    await this.ledger.append(openingEntry);
    const context = (): EventContext => ({ eventId: this.ids.next(), correlationId, occurredAt: at });
    await this.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, context())));
    await this.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, context())));
  }
}
