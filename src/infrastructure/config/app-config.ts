import { z } from "zod";

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof logLevels)[number];

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  HTTP_PORT: port.default(3000),
  LOG_LEVEL: z.enum(logLevels).default("info"),
  DB_HOST: z.string().min(1),
  DB_PORT: port,
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_POOL_MAX: positiveInt.default(10),
  DB_LOCK_TIMEOUT_MS: positiveInt.default(2000),
  AWS_REGION: z.string().min(1),
  SQS_ENDPOINT: z.url().optional(),
  SQS_WAGER_QUEUE_NAME: z.string().endsWith(".fifo"),
  SQS_WAGER_DLQ_NAME: z.string().endsWith(".fifo"),
  SQS_EVENTS_QUEUE_NAME: z.string().endsWith(".fifo").default("wager-events.fifo"),
  SQS_CONSUMER_ENABLED: z.enum(["true", "false"]).default("false"),
  SQS_CONSUMER_NAME: z.string().min(1).max(128).default("wager-transactions-consumer"),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
  SQS_CONSUMER_CONCURRENCY: positiveInt.optional(),
  SQS_RETRY_BASE_SECONDS: positiveInt.default(2),
  SQS_RETRY_MAX_SECONDS: positiveInt.max(43_200).default(300),
  SQS_SHUTDOWN_GRACE_MS: positiveInt.default(10_000),
  OUTBOX_PUBLISHER_ENABLED: z.enum(["true", "false"]).default("false"),
  OUTBOX_POLL_INTERVAL_MS: positiveInt.default(500),
  OUTBOX_BATCH_WALLETS: positiveInt.max(1_000).default(20),
  OUTBOX_BATCH_EVENTS_PER_WALLET: positiveInt.max(1_000).default(50),
  OUTBOX_PUBLISH_TIMEOUT_MS: positiveInt.default(5_000),
  REFERENCE_WORKER_ENABLED: z.enum(["true", "false"]).default("false"),
  REFERENCE_WORKER_POLL_INTERVAL_MS: positiveInt.default(1_000),
  REFERENCE_WORKER_BATCH: positiveInt.max(1_000).default(50),
  WORKER_SHUTDOWN_GRACE_MS: positiveInt.default(10_000),
  HEALTH_CHECK_TIMEOUT_MS: positiveInt.default(1000),
});

function consumerConcurrency(vars: z.infer<typeof envSchema>): number {
  return vars.SQS_CONSUMER_CONCURRENCY ?? Math.max(1, Math.floor(vars.DB_POOL_MAX / 2));
}

export class InvalidConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "InvalidConfigError";
  }
}

export class AppConfig {
  private constructor(
    readonly http: Readonly<{ port: number }>,
    readonly log: Readonly<{ level: LogLevel }>,
    readonly database: Readonly<{
      host: string;
      port: number;
      user: string;
      password: string;
      name: string;
      poolMax: number;
      lockTimeoutMs: number;
    }>,
    readonly sqs: Readonly<{
      region: string;
      endpoint: string | undefined;
      wagerQueueName: string;
      wagerDeadLetterQueueName: string;
      eventsQueueName: string;
      consumer: Readonly<{
        enabled: boolean;
        name: string;
        waitTimeSeconds: number;
        maxMessages: number;
        concurrency: number;
        retryBaseSeconds: number;
        retryMaxSeconds: number;
        shutdownGraceMs: number;
      }>;
    }>,
    readonly outbox: Readonly<{
      publisherEnabled: boolean;
      pollIntervalMs: number;
      batchOrderingKeys: number;
      batchMessagesPerOrderingKey: number;
      publishTimeoutMs: number;
    }>,
    readonly referenceWorker: Readonly<{ enabled: boolean; pollIntervalMs: number; batchSize: number }>,
    readonly workers: Readonly<{ shutdownGraceMs: number }>,
    readonly health: Readonly<{ timeoutMs: number }>,
  ) {
    Object.freeze(this);
  }

  static fromEnv(env: Record<string, string | undefined>): AppConfig {
    const result = envSchema.safeParse(env);
    if (!result.success) {
      throw new InvalidConfigError(
        result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      );
    }
    const vars = result.data;
    const concurrency = consumerConcurrency(vars);
    const backgroundConnections =
      (vars.SQS_CONSUMER_ENABLED === "true" ? concurrency : 0) +
      (vars.OUTBOX_PUBLISHER_ENABLED === "true" ? 1 : 0) +
      (vars.REFERENCE_WORKER_ENABLED === "true" ? 1 : 0);
    if (backgroundConnections >= vars.DB_POOL_MAX) {
      throw new InvalidConfigError([
        `DB_POOL_MAX: background work needs ${backgroundConnections} connection(s) (consumer ${vars.SQS_CONSUMER_ENABLED === "true" ? concurrency : 0}, publisher and worker 1 each when enabled) and must leave connections for the API, got ${vars.DB_POOL_MAX}`,
      ]);
    }
    return new AppConfig(
      Object.freeze({ port: vars.HTTP_PORT }),
      Object.freeze({ level: vars.LOG_LEVEL }),
      Object.freeze({
        host: vars.DB_HOST,
        port: vars.DB_PORT,
        user: vars.DB_USER,
        password: vars.DB_PASSWORD,
        name: vars.DB_NAME,
        poolMax: vars.DB_POOL_MAX,
        lockTimeoutMs: vars.DB_LOCK_TIMEOUT_MS,
      }),
      Object.freeze({
        region: vars.AWS_REGION,
        endpoint: vars.SQS_ENDPOINT,
        wagerQueueName: vars.SQS_WAGER_QUEUE_NAME,
        wagerDeadLetterQueueName: vars.SQS_WAGER_DLQ_NAME,
        eventsQueueName: vars.SQS_EVENTS_QUEUE_NAME,
        consumer: Object.freeze({
          enabled: vars.SQS_CONSUMER_ENABLED === "true",
          name: vars.SQS_CONSUMER_NAME,
          waitTimeSeconds: vars.SQS_WAIT_TIME_SECONDS,
          maxMessages: vars.SQS_MAX_MESSAGES,
          concurrency,
          retryBaseSeconds: vars.SQS_RETRY_BASE_SECONDS,
          retryMaxSeconds: vars.SQS_RETRY_MAX_SECONDS,
          shutdownGraceMs: vars.SQS_SHUTDOWN_GRACE_MS,
        }),
      }),
      Object.freeze({
        publisherEnabled: vars.OUTBOX_PUBLISHER_ENABLED === "true",
        pollIntervalMs: vars.OUTBOX_POLL_INTERVAL_MS,
        batchOrderingKeys: vars.OUTBOX_BATCH_WALLETS,
        batchMessagesPerOrderingKey: vars.OUTBOX_BATCH_EVENTS_PER_WALLET,
        publishTimeoutMs: vars.OUTBOX_PUBLISH_TIMEOUT_MS,
      }),
      Object.freeze({
        enabled: vars.REFERENCE_WORKER_ENABLED === "true",
        pollIntervalMs: vars.REFERENCE_WORKER_POLL_INTERVAL_MS,
        batchSize: vars.REFERENCE_WORKER_BATCH,
      }),
      Object.freeze({ shutdownGraceMs: vars.WORKER_SHUTDOWN_GRACE_MS }),
      Object.freeze({ timeoutMs: vars.HEALTH_CHECK_TIMEOUT_MS }),
    );
  }
}
