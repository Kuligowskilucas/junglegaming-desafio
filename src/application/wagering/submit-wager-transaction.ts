import type { EventContext } from "../../domain/events/event-context";
import type { IntegrationEvent } from "../../domain/events/integration-event";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, type MoneyProps } from "../../domain/shared/money";
import { type SettlementOutcome, settleWagerTransaction } from "../../domain/wagering/wager-settlement";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { Wallet } from "../../domain/wallet/wallet";
import { DuplicateExternalTransactionError, DuplicateWagerTransactionError, IdempotencyConflictError, WalletNotFoundError, WalletPlayerMismatchError,} from "../errors";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { OutboxRepository } from "../ports/outbox-repository";
import type { TransactionRunner } from "../ports/transaction-runner";
import type { WagerTransactionRepository } from "../ports/wager-transaction-repository";
import type { WalletLedgerRepository } from "../ports/wallet-ledger-repository";
import type { WalletRepository } from "../ports/wallet-repository";

export interface WagerTransactionPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  payload: WagerTransactionPayload;
  correlationId: string;
  causationId?: string | undefined;
}

export interface SubmissionResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

export class SubmitWagerTransaction {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly transactionRunner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
    const candidate = WagerTransaction.create({
      ...command.payload,
      kind: command.payload.kind as WagerTransactionKind,
      money: Money.from(command.payload.money),
      id: this.ids.next(),
      idempotencyKey: command.idempotencyKey,
      createdAt: this.clock.now(),
    });
    const previous = await this.transactions.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey);
    if (previous) {
      return this.replay(previous, candidate);
    }
    try {
      return await this.transactionRunner.run(() => this.process(candidate, command));
    } catch (error) {
      if (error instanceof DuplicateWagerTransactionError) {
        return this.resolveDuplicate(error, candidate);
      }
      throw error;
    }
  }

  private async process(
    candidate: WagerTransaction,
    command: SubmitWagerTransactionCommand,
  ): Promise<SubmissionResult> {
    const wallet = await this.wallets.findByIdForUpdate(candidate.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(candidate.walletId);
    }
    const previous = await this.transactions.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey);
    if (previous) {
      return this.replay(previous, candidate);
    }
    if (wallet.playerId !== candidate.playerId) {
      throw new WalletPlayerMismatchError(wallet.id, candidate.playerId);
    }
    const reference =
      candidate.referenceExternalTransactionId === undefined
        ? undefined
        : await this.transactions.findByExternalId(candidate.providerId, candidate.referenceExternalTransactionId);
    const referenceAlreadyReversed =
      reference !== undefined &&
      candidate.requiresReference() &&
      (await this.transactions.hasProcessedReversalOf(reference.id));
    const now = this.clock.now();
    const outcome = settleWagerTransaction({
      transaction: candidate,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at: now < candidate.createdAt ? candidate.createdAt : now,
    });
    await this.transactions.add(candidate);
    if (outcome.status === WagerTransactionStatus.Processed && outcome.entry) {
      await this.ledger.append(outcome.entry);
      await this.wallets.update(wallet);
    }
    for (const event of this.eventsFor(candidate, wallet, outcome, command)) {
      await this.outbox.add(OutboxMessage.enqueue(event));
    }
    return { transaction: candidate, idempotentReplay: false };
  }

  private replay(previous: WagerTransaction, candidate: WagerTransaction): SubmissionResult {
    if (!previous.matchesPayload(candidate.payloadHash)) {
      throw new IdempotencyConflictError(previous.providerId, previous.idempotencyKey, previous.id);
    }
    return { transaction: previous, idempotentReplay: true };
  }

  private async resolveDuplicate(
    error: DuplicateWagerTransactionError,
    candidate: WagerTransaction,
  ): Promise<SubmissionResult> {
    if (error.uniqueness === "IDEMPOTENCY_KEY") {
      const winner = await this.transactions.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey);
      if (winner) {
        return this.replay(winner, candidate);
      }
    } else {
      const existing = await this.transactions.findByExternalId(candidate.providerId, candidate.externalTransactionId);
      if (existing) {
        throw new DuplicateExternalTransactionError(candidate.providerId, candidate.externalTransactionId, existing.id);
      }
    }
    throw error;
  }

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: SettlementOutcome,
    command: SubmitWagerTransactionCommand,
  ): IntegrationEvent<unknown>[] {
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
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
        return [WagerTransactionPendingReference.from(transaction, context())];
    }
  }
}
