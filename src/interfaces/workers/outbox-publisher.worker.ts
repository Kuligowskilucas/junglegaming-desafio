import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { type PublicationReport, PublishPendingEvents } from "../../application/messaging/publish-pending-events";
import { AppConfig } from "../../infrastructure/config/app-config";
import { DatabaseContext } from "../../infrastructure/database/database-context";
import { type CycleResult, PollingLoop } from "./polling-loop";

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly enabled: boolean;
  private readonly loop: PollingLoop;

  constructor(
    private readonly publishPendingEvents: PublishPendingEvents,
    private readonly databaseContext: DatabaseContext,
    private readonly pino: PinoLogger,
    config: AppConfig,
  ) {
    this.enabled = config.outbox.publisherEnabled;
    this.loop = new PollingLoop(
      "Outbox publisher",
      { idleDelayMs: config.outbox.pollIntervalMs, shutdownGraceMs: config.workers.shutdownGraceMs },
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
      () => this.databaseContext.run(async () => this.report(await this.publishPendingEvents.runOnce())),
      { bindings: { worker: "outbox-publisher" } },
    );
  }

  private report(report: PublicationReport): CycleResult {
    for (const failure of report.failures) {
      this.logger.warn(
        { err: failure.error, eventId: failure.eventId, orderingKey: failure.orderingKey },
        "Event publication failed; it and the following events of the same wallet wait for the retry",
      );
    }
    if (report.published > 0) {
      this.logger.log({ claimed: report.claimed, published: report.published }, "Outbox events published");
      return "BUSY";
    }
    return "IDLE";
  }
}
