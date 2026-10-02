import type { EventContext } from "../../domain/events/event-context";
import type { IntegrationEvent } from "../../domain/events/integration-event";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { type SettlementOutcome, settleWagerTransaction } from "../../domain/wagering/wager-settlement";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { OutboxRepository } from "../ports/outbox-repository";
import type { WagerTransactionRepository } from "../ports/wager-transaction-repository";
import type { WalletLedgerRepository } from "../ports/wallet-ledger-repository";
import type { WalletRepository } from "../ports/wallet-repository";

export interface SettleAndRecordInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  persistence: "INSERT" | "UPDATE";
  causationId: string | undefined;
}

export class SettleAndRecord {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: SettleAndRecordInput): Promise<SettlementOutcome> {
    const { transaction, wallet } = input;
    const firstEvaluation = transaction.status === WagerTransactionStatus.Pending;
    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await this.transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId);
    const referenceAlreadyReversed =
      reference !== undefined &&
      transaction.requiresReference() &&
      (await this.transactions.hasProcessedReversalOf(reference.id));
    const now = this.clock.now();
    const at = now < transaction.updatedAt ? transaction.updatedAt : now;
    const outcome = settleWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at,
    });
    if (input.persistence === "INSERT") {
      await this.transactions.add(transaction);
    } else {
      await this.transactions.update(transaction);
    }
    if (outcome.status === WagerTransactionStatus.Processed && outcome.entry) {
      await this.ledger.append(outcome.entry);
      await this.wallets.update(wallet);
    }
    for (const event of this.eventsFor(transaction, wallet, outcome, firstEvaluation, input.causationId)) {
      await this.outbox.add(OutboxMessage.enqueue(event));
    }
    if (transaction.isTerminal()) {
      await this.transactions.rescheduleDependentsOf(transaction.providerId, transaction.externalTransactionId, at);
    }
    return outcome;
  }

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: SettlementOutcome,
    firstEvaluation: boolean,
    causationId: string | undefined,
  ): IntegrationEvent<unknown>[] {
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: transaction.correlationId,
      causationId,
      occurredAt: transaction.updatedAt,
    });
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        return outcome.entry
          ? [WagerTransactionProcessed.from(transaction, context()), WalletBalanceChanged.from(wallet, outcome.entry, context())]
          : [WagerTransactionProcessed.from(transaction, context())];
      case WagerTransactionStatus.Rejected:
        return [WagerTransactionRejected.from(transaction, context())];
      case WagerTransactionStatus.PendingReference:
        return firstEvaluation ? [WagerTransactionPendingReference.from(transaction, context())] : [];
    }
  }
}
