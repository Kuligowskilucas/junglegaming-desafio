import { Injectable, Logger } from "@nestjs/common";
import { Gauge, Registry } from "prom-client";
import { AppConfig } from "../config/app-config";
import { BacklogProbe } from "../database/backlog.probe";
import { SqsQueueDepthProbe } from "../messaging/sqs-queue-depth.probe";
import { rejectWhenAborted } from "./abortable";
import { type ProbeName, WageringMetrics } from "./wagering-metrics";

type QueueRole = "requests" | "requests_dlq" | "events";

@Injectable()
export class BacklogGauges {
  private readonly logger = new Logger(BacklogGauges.name);
  private readonly outboxPending: Gauge;
  private readonly outboxOldestAge: Gauge;
  private readonly pendingReferences: Gauge;
  private readonly queueMessages: Gauge<"queue" | "state">;

  constructor(
    registry: Registry,
    private readonly metrics: WageringMetrics,
    private readonly backlog: BacklogProbe,
    private readonly queueDepth: SqsQueueDepthProbe,
    private readonly config: AppConfig,
  ) {
    const registers = [registry];
    this.outboxPending = new Gauge({
      name: "wagering_outbox_pending_events",
      help: "Outbox events not published yet (NaN when the probe fails)",
      registers,
    });
    this.outboxOldestAge = new Gauge({
      name: "wagering_outbox_oldest_pending_age_seconds",
      help: "Age of the oldest unpublished outbox event, the outbox lag (NaN when the probe fails)",
      registers,
    });
    this.pendingReferences = new Gauge({
      name: "wagering_pending_reference_transactions",
      help: "Transactions waiting for their reference (NaN when the probe fails)",
      registers,
    });
    this.queueMessages = new Gauge({
      name: "wagering_sqs_queue_messages",
      help: "Approximate messages per queue and state; requests_dlq is the dead-letter queue (NaN when the probe fails)",
      labelNames: ["queue", "state"],
      registers,
    });
  }

  async refresh(): Promise<void> {
    await Promise.all([
      this.refreshOutbox(),
      this.refreshPendingReferences(),
      ...this.queues().map(([queue, queueName]) => this.refreshQueue(queue, queueName)),
    ]);
  }

  private async refreshOutbox(): Promise<void> {
    const backlog = await this.probe("outbox", () => this.backlog.outbox());
    this.outboxPending.set(backlog?.pending ?? Number.NaN);
    this.outboxOldestAge.set(backlog === undefined ? Number.NaN : ageInSeconds(backlog.oldestOccurredAt));
  }

  private async refreshPendingReferences(): Promise<void> {
    this.pendingReferences.set((await this.probe("pending_references", () => this.backlog.pendingReferences())) ?? Number.NaN);
  }

  private async refreshQueue(queue: QueueRole, queueName: string): Promise<void> {
    const depth = await this.probe("sqs", (signal) => this.queueDepth.depth(queueName, signal));
    this.queueMessages.set({ queue, state: "visible" }, depth?.visible ?? Number.NaN);
    this.queueMessages.set({ queue, state: "in_flight" }, depth?.inFlight ?? Number.NaN);
  }

  private queues(): [QueueRole, string][] {
    return [
      ["requests", this.config.sqs.wagerQueueName],
      ["requests_dlq", this.config.sqs.wagerDeadLetterQueueName],
      ["events", this.config.sqs.eventsQueueName],
    ];
  }

  private async probe<T>(name: ProbeName, run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const signal = AbortSignal.timeout(this.config.health.timeoutMs);
    try {
      return await Promise.race([run(signal), rejectWhenAborted(signal)]);
    } catch (error) {
      this.metrics.probeFailed(name);
      this.logger.warn({ probe: name, timedOut: signal.aborted, err: error }, "Metrics probe failed");
      return undefined;
    }
  }
}

function ageInSeconds(oldest: Date | undefined): number {
  return oldest === undefined ? 0 : Math.max(0, (Date.now() - oldest.getTime()) / 1_000);
}
