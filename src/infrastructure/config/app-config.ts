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
  HEALTH_CHECK_TIMEOUT_MS: positiveInt.default(1000),
});

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
    }>,
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
      }),
      Object.freeze({ timeoutMs: vars.HEALTH_CHECK_TIMEOUT_MS }),
    );
  }
}
