import { setTimeout as delay } from "node:timers/promises";
import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import {
  HandleWagerTransactionRequested,
  type MessageHandlingResult,
} from "../../application/messaging/handle-wager-transaction-requested";
import { backoffDelayMs } from "../../domain/shared/retry-backoff";
import { AppConfig } from "../../infrastructure/config/app-config";
import { DatabaseContext } from "../../infrastructure/database/database-context";
import { isAcceptedCorrelationId } from "../../infrastructure/observability/correlation-id";
import { type ReceivedMessage, SqsQueueGateway } from "../../infrastructure/messaging/sqs-queue-gateway";
import { ConcurrencyLimit } from "./concurrency-limit";
import { classifyFailure, type FailureClassification } from "./failure-classification";
import {
  parseWagerTransactionMessage,
  toWagerTransactionRequest,
  type WagerTransactionRequestedEnvelope,
} from "./wager-transaction-message";

type Disposition = "SETTLED" | "RETRY" | "RELEASE";

const receiveFailurePauseMs = 1_000;
const unparseableGroupId = "unparseable";

@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private readonly settings: AppConfig["sqs"]["consumer"];
  private readonly queueName: string;
  private readonly deadLetterQueueName: string;
  private readonly slots: ConcurrencyLimit;
  private stopping = false;
  private running: Promise<void> | undefined;
  private polling: AbortController | undefined;

  constructor(
    private readonly gateway: SqsQueueGateway,
    private readonly handler: HandleWagerTransactionRequested,
    private readonly databaseContext: DatabaseContext,
    private readonly pino: PinoLogger,
    config: AppConfig,
  ) {
    this.settings = config.sqs.consumer;
    this.queueName = config.sqs.wagerQueueName;
    this.deadLetterQueueName = config.sqs.wagerDeadLetterQueueName;
    this.slots = new ConcurrencyLimit(this.settings.concurrency);
  }

  onApplicationBootstrap(): void {
    if (this.settings.enabled) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.stopping = false;
    this.running = this.poll();
    this.logger.log(
      { queue: this.queueName, concurrency: this.settings.concurrency, consumerName: this.settings.name },
      "SQS consumer started",
    );
  }

  async stop(): Promise<void> {
    const running = this.running;
    if (!running) {
      return;
    }
    this.stopping = true;
    this.polling?.abort();
    const drained = await Promise.race([
      running.then(() => true),
      delay(this.settings.shutdownGraceMs).then(() => false),
    ]);
    if (!drained) {
      this.logger.warn(
        { graceMs: this.settings.shutdownGraceMs },
        "Shutdown grace elapsed with messages still in progress; unfinished ones roll back and are redelivered",
      );
    }
    this.running = undefined;
    this.logger.log("SQS consumer stopped");
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      const batch = await this.receive();
      if (batch.length > 0) {
        await this.processBatch(batch);
      }
    }
  }

  private async receive(): Promise<ReceivedMessage[]> {
    this.polling = new AbortController();
    try {
      return await this.gateway.receive(this.queueName, {
        maxMessages: this.settings.maxMessages,
        waitTimeSeconds: this.settings.waitTimeSeconds,
        abortSignal: this.polling.signal,
      });
    } catch (error) {
      if (!this.stopping) {
        this.logger.error({ err: error }, "Receiving from SQS failed");
        await delay(receiveFailurePauseMs);
      }
      return [];
    } finally {
      this.polling = undefined;
    }
  }

  private async processBatch(batch: ReceivedMessage[]): Promise<void> {
    const groups = new Map<string, ReceivedMessage[]>();
    for (const message of batch) {
      const group = message.groupId ?? message.sqsMessageId;
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  private async processGroup(group: ReceivedMessage[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      const disposition = await this.slots.run(() =>
        this.stopping ? Promise.resolve<Disposition>("RELEASE") : this.process(message),
      );
      if (disposition !== "SETTLED") {
        await this.release(group.slice(disposition === "RELEASE" ? index : index + 1));
        return;
      }
    }
  }

  private process(message: ReceivedMessage): Promise<Disposition> {
    return this.pino.runInContext(() => this.databaseContext.run(() => this.processInContext(message)), {
      bindings: {
        consumerName: this.settings.name,
        sqsMessageId: message.sqsMessageId,
        receiveCount: message.receiveCount,
      },
    });
  }

  private async processInContext(message: ReceivedMessage): Promise<Disposition> {
    let envelope: WagerTransactionRequestedEnvelope | undefined;
    let result: MessageHandlingResult;
    try {
      envelope = parseWagerTransactionMessage(message.body);
      const received = message.attributes.correlationId;
      const correlationId = isAcceptedCorrelationId(received) ? received : envelope.messageId;
      this.pino.assign({ messageId: envelope.messageId, correlationId });
      result = await this.handler.handle(
        toWagerTransactionRequest(envelope, { consumerName: this.settings.name, correlationId }),
      );
    } catch (error) {
      const failure = classifyFailure(error);
      return failure.kind === "PERMANENT"
        ? this.deadLetter(message, envelope, failure)
        : this.retryLater(message, failure, error);
    }
    this.logHandled(result, envelope);
    await this.acknowledge(message);
    return "SETTLED";
  }

  private logHandled(result: MessageHandlingResult, envelope: WagerTransactionRequestedEnvelope): void {
    if (result.outcome === "DUPLICATE") {
      this.logger.log("Duplicate message acknowledged without effects");
      return;
    }
    const { transaction, idempotentReplay } = result.submission;
    this.logger.log(
      {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: envelope.data.providerId,
        status: transaction.status,
        failureCode: transaction.failureCode,
        idempotentReplay,
      },
      "Wager transaction message handled",
    );
  }

  private async deadLetter(
    message: ReceivedMessage,
    envelope: WagerTransactionRequestedEnvelope | undefined,
    failure: Extract<FailureClassification, { kind: "PERMANENT" }>,
  ): Promise<Disposition> {
    try {
      await this.gateway.send(this.deadLetterQueueName, {
        body: message.body,
        groupId: message.groupId ?? unparseableGroupId,
        deduplicationId: envelope?.messageId ?? message.sqsMessageId,
        attributes: {
          errorCode: failure.code,
          errorMessage: failure.detail.slice(0, 1_024),
          consumerName: this.settings.name,
          failedAt: new Date().toISOString(),
          receiveCount: String(message.receiveCount),
        },
      });
    } catch (error) {
      return this.retryLater(message, { kind: "TRANSIENT", code: "DEAD_LETTER_UNAVAILABLE" }, error);
    }
    this.logger.warn({ errorCode: failure.code }, "Message sent to the dead-letter queue as a permanent failure");
    await this.acknowledge(message);
    return "SETTLED";
  }

  private async retryLater(message: ReceivedMessage, failure: FailureClassification, error: unknown): Promise<Disposition> {
    const delaySeconds = Math.ceil(
      backoffDelayMs(
        { baseDelayMs: this.settings.retryBaseSeconds * 1_000, maxDelayMs: this.settings.retryMaxSeconds * 1_000 },
        message.receiveCount,
      ) / 1_000,
    );
    this.logger.warn(
      { err: error, code: failure.code, retryInSeconds: delaySeconds },
      "Message failed transiently and will be retried",
    );
    try {
      await this.gateway.changeVisibility(this.queueName, message.receiptHandle, delaySeconds);
    } catch (visibilityError) {
      this.logger.warn({ err: visibilityError }, "Could not schedule the retry; the queue visibility timeout applies");
    }
    return "RETRY";
  }

  private async acknowledge(message: ReceivedMessage): Promise<void> {
    try {
      await this.gateway.delete(this.queueName, message.receiptHandle);
    } catch (error) {
      this.logger.warn({ err: error }, "Acknowledgement failed; the redelivery will be deduplicated by the inbox");
    }
  }

  private async release(messages: ReceivedMessage[]): Promise<void> {
    await Promise.all(
      messages.map(async (message) => {
        try {
          await this.gateway.changeVisibility(this.queueName, message.receiptHandle, 0);
        } catch (error) {
          this.logger.warn({ err: error, sqsMessageId: message.sqsMessageId }, "Could not release the message");
        }
      }),
    );
  }
}
