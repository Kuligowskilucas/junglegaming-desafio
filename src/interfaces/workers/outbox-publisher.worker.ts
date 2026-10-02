import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { type PublicationReport, PublishPendingEvents } from "../../application/messaging/publish-pending-events";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { AppConfig } from "../../infrastructure/config/app-config";
import { DatabaseContext } from "../../infrastructure/database/database-context";
import { WageringMetrics } from "../../infrastructure/observability/wagering-metrics";
import { failureReason } from "./failure-reason";
import { type CycleResult, PollingLoop } from "./polling-loop";

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly enabled: boolean;
  private readonly loop: PollingLoop;

  constructor(
    private readonly publishPendingEvents: PublishPendingEvents,
    private readonly databaseContext: DatabaseContext,
    private readonly metrics: WageringMetrics,
    pino: PinoLogger,
    config: AppConfig,
  ) {
    this.enabled = config.outbox.publisherEnabled;
    this.loop = new PollingLoop(
      "Outbox publisher",
      { idleDelayMs: config.outbox.pollIntervalMs, shutdownGraceMs: config.workers.shutdownGraceMs },
      this.logger,
      (cycle) => pino.runInContext(cycle, { bindings: { worker: "outbox-publisher" } }),
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
      return this.report(await this.databaseContext.run(() => this.publishPendingEvents.runOnce()));
    } catch (error) {
      this.metrics.retryScheduled("outbox_publisher", failureReason(error));
      throw error;
    }
  }

  private report(report: PublicationReport): CycleResult {
    for (const message of report.published) {
      const delayMs = (message.publishedAt?.getTime() ?? Date.now()) - message.occurredAt.getTime();
      this.metrics.eventPublished(delayMs / 1_000);
      this.logger.log({ ...eventLogFields(message), delayMs }, "Outbox event published");
    }
    for (const failure of report.failures) {
      this.metrics.retryScheduled("outbox_publisher", "PUBLISH_FAILED");
      this.logger.warn(
        { ...eventLogFields(failure.message), attempts: failure.message.attempts, err: failure.error },
        "Event publication failed; it and the following events of the same wallet wait for the retry",
      );
    }
    return report.published.length > 0 ? "BUSY" : "IDLE";
  }
}

function eventLogFields(message: OutboxMessage): Record<string, string> {
  const data = message.payload.data;
  const fields: Record<string, unknown> = {
    eventId: message.id,
    eventType: message.eventType,
    walletId: message.orderingKey,
    correlationId: message.payload.correlationId,
    transactionId: isRecord(data) ? data.transactionId : undefined,
    providerId: isRecord(data) ? data.providerId : undefined,
  };
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
