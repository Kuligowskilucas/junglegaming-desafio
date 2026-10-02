import { Counter, Histogram, type Registry } from "prom-client";
import type { SubmissionResult } from "../../application/wagering/submit-wager-transaction";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";
import type { LockConflict } from "../database/transient-error";

export type MetricSource = "http" | "sqs" | "worker";
export type RetryComponent = "sqs_consumer" | "outbox_publisher" | "reference_worker";
export type ProcessingResult = WagerTransactionStatus | "REPLAY" | "DUPLICATE" | "RETRY" | "DEAD_LETTER" | "ERROR";
export type ProbeName = "outbox" | "pending_references" | "sqs";

export function secondsSince(startedAt: number): number {
  return (performance.now() - startedAt) / 1_000;
}

export class WageringMetrics {
  private readonly transactions: Counter<"source" | "kind" | "status" | "failure_code">;
  private readonly duplicates: Counter<"source" | "type">;
  private readonly retries: Counter<"component" | "reason">;
  private readonly deadLetters: Counter<"code">;
  private readonly lockConflicts: Counter<"type">;
  private readonly reconciliations: Counter<"result">;
  private readonly probeFailures: Counter<"probe">;
  private readonly processingDuration: Histogram<"source" | "result">;
  private readonly publicationDelay: Histogram;
  private readonly walletLockWait: Histogram;

  constructor(readonly registry: Registry) {
    const registers = [registry];
    this.transactions = new Counter({
      name: "wagering_transactions_total",
      help: "Wager transactions that entered a status, replays excluded",
      labelNames: ["source", "kind", "status", "failure_code"],
      registers,
    });
    this.duplicates = new Counter({
      name: "wagering_duplicates_total",
      help: "Duplicates detected by idempotent replay or by the inbox",
      labelNames: ["source", "type"],
      registers,
    });
    this.retries = new Counter({
      name: "wagering_retries_total",
      help: "Retries scheduled by the consumer, the outbox publisher and the reference worker",
      labelNames: ["component", "reason"],
      registers,
    });
    this.deadLetters = new Counter({
      name: "wagering_dead_lettered_total",
      help: "Messages the consumer sent to the dead-letter queue as permanent failures",
      labelNames: ["code"],
      registers,
    });
    this.lockConflicts = new Counter({
      name: "wagering_lock_conflicts_total",
      help: "SQL transactions that failed on a lock timeout or a deadlock",
      labelNames: ["type"],
      registers,
    });
    this.reconciliations = new Counter({
      name: "wagering_reconciliations_total",
      help: "Wallet reconciliations by result",
      labelNames: ["result"],
      registers,
    });
    this.probeFailures = new Counter({
      name: "wagering_metrics_probe_failures_total",
      help: "Scrape-time probes that failed or timed out",
      labelNames: ["probe"],
      registers,
    });
    this.processingDuration = new Histogram({
      name: "wagering_processing_duration_seconds",
      help: "Time to process a wager transaction submission, message or pending reference",
      labelNames: ["source", "result"],
      registers,
    });
    this.publicationDelay = new Histogram({
      name: "wagering_outbox_publication_delay_seconds",
      help: "Time between an event being committed to the outbox and being published",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
      registers,
    });
    this.walletLockWait = new Histogram({
      name: "wagering_wallet_lock_wait_seconds",
      help: "Time spent acquiring the wallet row lock",
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers,
    });
  }

  transactionEntered(source: MetricSource, transaction: WagerTransaction): void {
    this.transactions.inc({
      source,
      kind: transaction.kind,
      status: transaction.status,
      failure_code: transaction.failureCode ?? "none",
    });
  }

  openingRecorded(): void {
    this.transactions.inc({ source: "http", kind: "OPENING", status: "PROCESSED", failure_code: "none" });
  }

  submissionCompleted(source: "http" | "sqs", result: SubmissionResult, seconds: number): void {
    if (result.idempotentReplay) {
      this.duplicates.inc({ source, type: "idempotent_replay" });
      this.processingObserved(source, "REPLAY", seconds);
      return;
    }
    this.transactionEntered(source, result.transaction);
    this.processingObserved(source, result.transaction.status, seconds);
  }

  inboxDuplicate(seconds: number): void {
    this.duplicates.inc({ source: "sqs", type: "inbox" });
    this.processingObserved("sqs", "DUPLICATE", seconds);
  }

  processingObserved(source: MetricSource, result: ProcessingResult, seconds: number): void {
    this.processingDuration.observe({ source, result }, seconds);
  }

  retryScheduled(component: RetryComponent, reason: string): void {
    this.retries.inc({ component, reason });
  }

  deadLettered(code: string): void {
    this.deadLetters.inc({ code });
  }

  lockConflict(type: LockConflict): void {
    this.lockConflicts.inc({ type });
  }

  walletLockWaited(seconds: number): void {
    this.walletLockWait.observe(seconds);
  }

  eventPublished(delaySeconds: number): void {
    this.publicationDelay.observe(Math.max(0, delaySeconds));
  }

  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? "consistent" : "inconsistent" });
  }

  probeFailed(probe: ProbeName): void {
    this.probeFailures.inc({ probe });
  }
}
