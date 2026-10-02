import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import {
  type ReferenceRetryReport,
  RetryPendingReferences,
} from "../../application/wagering/retry-pending-references";
import { AppConfig } from "../../infrastructure/config/app-config";
import { DatabaseContext } from "../../infrastructure/database/database-context";
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
    private readonly pino: PinoLogger,
    config: AppConfig,
  ) {
    this.enabled = config.referenceWorker.enabled;
    this.batchSize = config.referenceWorker.batchSize;
    this.loop = new PollingLoop(
      "Pending reference worker",
      { idleDelayMs: config.referenceWorker.pollIntervalMs, shutdownGraceMs: config.workers.shutdownGraceMs },
      this.logger,
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

  private cycle(): Promise<CycleResult> {
    return this.pino.runInContext(
      () => this.databaseContext.run(async () => this.report(await this.retryPendingReferences.runOnce())),
      { bindings: { worker: "pending-reference" } },
    );
  }

  private report(report: ReferenceRetryReport): CycleResult {
    for (const transaction of report.settled) {
      this.logger.log(
        {
          transactionId: transaction.id,
          walletId: transaction.walletId,
          correlationId: transaction.correlationId,
          status: transaction.status,
          failureCode: transaction.failureCode,
          referenceAttempts: transaction.referenceAttempts,
          nextReferenceAttemptAt: transaction.nextReferenceAttemptAt,
        },
        "Pending reference transaction evaluated",
      );
    }
    for (const failure of report.failures) {
      this.logger.warn(
        { err: failure.error, transactionId: failure.transactionId },
        "Pending reference retry failed; it stays due for the next cycle",
      );
    }
    return report.due === this.batchSize && report.failures.length === 0 ? "BUSY" : "IDLE";
  }
}
