import { describe, expect, test } from "bun:test";
import { AppConfig, InvalidConfigError } from "../../../src/infrastructure/config/app-config";

const validEnv = {
  DB_HOST: "localhost",
  DB_PORT: "5433",
  DB_USER: "wagering",
  DB_PASSWORD: "wagering",
  DB_NAME: "wagering",
  AWS_REGION: "us-east-1",
  SQS_ENDPOINT: "http://localhost:4566",
  SQS_WAGER_QUEUE_NAME: "wager-transactions.fifo",
  SQS_WAGER_DLQ_NAME: "wager-transactions-dlq.fifo",
};

function issuesOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    AppConfig.fromEnv(env);
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("expected InvalidConfigError");
}

describe("AppConfig.fromEnv", () => {
  test("builds a typed config and applies defaults", () => {
    const config = AppConfig.fromEnv(validEnv);

    expect(config.http.port).toBe(3000);
    expect(config.log.level).toBe("info");
    expect(config.database).toEqual({
      host: "localhost",
      port: 5433,
      user: "wagering",
      password: "wagering",
      name: "wagering",
      poolMax: 10,
      lockTimeoutMs: 2000,
    });
    expect(config.sqs).toEqual({
      region: "us-east-1",
      endpoint: "http://localhost:4566",
      wagerQueueName: "wager-transactions.fifo",
      wagerDeadLetterQueueName: "wager-transactions-dlq.fifo",
    });
    expect(config.health.timeoutMs).toBe(1000);
  });

  test("allows omitting the SQS endpoint to target real AWS", () => {
    const { SQS_ENDPOINT, ...env } = validEnv;

    expect(AppConfig.fromEnv(env).sqs.endpoint).toBeUndefined();
  });

  test("is immutable", () => {
    const config = AppConfig.fromEnv(validEnv);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  test("reports every invalid or missing variable by name", () => {
    const { DB_HOST, ...env } = validEnv;

    const issues = issuesOf({ ...env, DB_PORT: "abc", LOG_LEVEL: "verbose", SQS_WAGER_QUEUE_NAME: "standard-queue" });

    expect(issues.map((issue) => issue.split(":")[0])).toEqual(
      expect.arrayContaining(["DB_HOST", "DB_PORT", "LOG_LEVEL", "SQS_WAGER_QUEUE_NAME"]),
    );
    expect(issues).toHaveLength(4);
  });

  test("rejects out-of-range ports", () => {
    expect(issuesOf({ ...validEnv, HTTP_PORT: "70000" })).toEqual([expect.stringMatching(/^HTTP_PORT:/)]);
  });
});
