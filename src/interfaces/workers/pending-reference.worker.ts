import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import {
  type ReferenceRetryReport,
  type ReferenceRetrySettlement,
  RetryPendingReferences,
} from "../../application/wagering/retry-pending-references";
import { AppConfig } from "../../infrastructure/config/app-config";
import { DatabaseContext } from "../../infrastructure/database/database-context";
import { WageringMetrics } from "../../infrastructure/observability/wagering-metrics";
import { failureReason } from "./failure-reason";
import { type CycleResult, PollingLoop } from "./polling-loop";

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly loop: PollingLoop;

  constructor(
    private readonly retryPendingReferences: RetryPendingReferences,
    private readonly databaseContext: DatabaseContext,
    private readonly metrics: WageringMetrics,
    pino: PinoLogger,
    config: AppConfig,
  ) {
    this.enabled = config.referenceWorker.enabled;
    this.batchSize = config.referenceWorker.batchSize;
    this.loop = new PollingLoop(
      "Pending reference worker",
      { idleDelayMs: config.referenceWorker.pollIntervalMs, shutdownGraceMs: config.workers.shutdownGraceMs },
      this.logger,
      (cycle) => pino.runInContext(cycle, { bindings: { worker: "pending-reference" } }),
      () => this.cycle(),
    );
  }

  onApplicationBootstrap(): void {
    if (this.enabled) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  private async cycle(): Promise<CycleResult> {
    try {
      return this.report(await this.databaseContext.run(() => this.retryPendingReferences.runOnce()));
    } catch (error) {
      this.metrics.retryScheduled("reference_worker", failureReason(error));
      throw error;
    }
  }

  private report(report: ReferenceRetryReport): CycleResult {
    for (const settlement of report.settled) {
      this.record(settlement);
    }
    for (const failure of report.failures) {
      this.metrics.retryScheduled("reference_worker", failureReason(failure.error));
      this.logger.warn(
        { err: failure.error, transactionId: failure.transactionId, walletId: failure.walletId },
        "Pending reference retry failed; it stays due for the next cycle",
      );
    }
    return report.due === this.batchSize && report.failures.length === 0 ? "BUSY" : "IDLE";
  }

  private record({ transaction, durationMs }: ReferenceRetrySettlement): void {
    if (transaction.isTerminal()) {
      this.metrics.transactionEntered("worker", transaction);
    } else {
      this.metrics.retryScheduled("reference_worker", "REFERENCE_MISSING");
    }
    this.metrics.processingObserved("worker", transaction.status, durationMs / 1_000);
    this.logger.log(
      {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        correlationId: transaction.correlationId,
        status: transaction.status,
        failureCode: transaction.failureCode,
        referenceAttempts: transaction.referenceAttempts,
        nextReferenceAttemptAt: transaction.nextReferenceAttemptAt,
      },
      "Pending reference transaction evaluated",
    );
  }
}
