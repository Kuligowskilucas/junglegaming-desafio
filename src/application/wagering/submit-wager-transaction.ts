import { Money, type MoneyProps } from "../../domain/shared/money";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WagerTransactionKind } from "../../domain/wagering/wager-transaction-kind";
import { DuplicateExternalTransactionError, DuplicateWagerTransactionError, IdempotencyConflictError, WalletNotFoundError, WalletPlayerMismatchError,} from "../errors";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { TransactionRunner } from "../ports/transaction-runner";
import type { WagerTransactionRepository } from "../ports/wager-transaction-repository";
import type { WalletRepository } from "../ports/wallet-repository";
import type { SettleAndRecord } from "./settle-and-record";

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
    private readonly settleAndRecord: SettleAndRecord,
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
      correlationId: command.correlationId,
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
    await this.settleAndRecord.execute({
      transaction: candidate,
      wallet,
      persistence: "INSERT",
      causationId: command.causationId,
    });
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
}
