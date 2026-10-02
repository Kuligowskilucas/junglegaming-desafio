import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { Clock } from "../ports/clock";
import type { TransactionRunner } from "../ports/transaction-runner";
import type { DueReferenceRetry, WagerTransactionRepository } from "../ports/wager-transaction-repository";
import type { WalletRepository } from "../ports/wallet-repository";
import type { SettleAndRecord } from "./settle-and-record";

export interface ReferenceRetryFailure {
  transactionId: string;
  walletId: string;
  error: unknown;
}

export interface ReferenceRetrySettlement {
  transaction: WagerTransaction;
  durationMs: number;
}

export interface ReferenceRetryReport {
  due: number;
  settled: ReferenceRetrySettlement[];
  skipped: number;
  failures: ReferenceRetryFailure[];
}

export class RetryPendingReferences {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly settleAndRecord: SettleAndRecord,
    private readonly transactionRunner: TransactionRunner,
    private readonly clock: Clock,
    private readonly batchSize: number,
  ) {}

  async runOnce(): Promise<ReferenceRetryReport> {
    const due = await this.transactions.findDueForReferenceRetry(this.clock.now(), this.batchSize);
    const report: ReferenceRetryReport = { due: due.length, settled: [], skipped: 0, failures: [] };
    for (const candidate of due) {
      try {
        const startedAt = this.clock.now().getTime();
        const settled = await this.retry(candidate);
        if (settled) {
          report.settled.push({ transaction: settled, durationMs: this.clock.now().getTime() - startedAt });
        } else {
          report.skipped += 1;
        }
      } catch (error) {
        report.failures.push({ transactionId: candidate.transactionId, walletId: candidate.walletId, error });
      }
    }
    return report;
  }

  private retry(candidate: DueReferenceRetry): Promise<WagerTransaction | undefined> {
    return this.transactionRunner.run(async () => {
      const wallet = await this.wallets.findByIdForUpdate(candidate.walletId);
      const transaction = await this.transactions.findById(candidate.transactionId);
      const nextAttemptAt = transaction?.nextReferenceAttemptAt;
      if (
        !wallet ||
        !transaction ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        (nextAttemptAt !== undefined && nextAttemptAt > this.clock.now())
      ) {
        return undefined;
      }
      await this.settleAndRecord.execute({ transaction, wallet, persistence: "UPDATE", causationId: undefined });
      return transaction;
    });
  }
}
