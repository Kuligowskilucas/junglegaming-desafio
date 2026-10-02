import { afterAll, beforeAll, setDefaultTimeout } from "bun:test";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { SQL, type ReservedSQL } from "bun";
import { AppConfig } from "../../src/infrastructure/config/app-config";

const integrationTestsLockKey = 4_271_001;
const lockWaitTimeoutMs = 600_000;
const preflightTimeoutMs = 3_000;
const infrastructureHint = "rode `docker compose up -d --wait` antes dos testes de integração";
const integrationTestTimeoutMs = 30_000;

export function useIntegrationEnvironment(options: { testTimeoutMs?: number } = {}): void {
  setDefaultTimeout(options.testTimeoutMs ?? integrationTestTimeoutMs);
  let pool: SQL | undefined;
  let lockConnection: ReservedSQL | undefined;

  beforeAll(async () => {
    const config = AppConfig.fromEnv(process.env);
    await assertSqsReachable(config);
    pool = new SQL({
      hostname: config.database.host,
      port: config.database.port,
      username: config.database.user,
      password: config.database.password,
      database: config.database.name,
      max: 1,
      connectionTimeout: preflightTimeoutMs / 1000,
    });
    try {
      lockConnection = await pool.reserve();
    } catch (error) {
      throw new Error(`PostgreSQL inacessível em ${config.database.host}:${config.database.port}: ${infrastructureHint}`, {
        cause: error,
      });
    }
    await lockConnection`select pg_advisory_lock(${integrationTestsLockKey})`;
  }, lockWaitTimeoutMs);

  afterAll(async () => {
    if (lockConnection) {
      await lockConnection`select pg_advisory_unlock(${integrationTestsLockKey})`;
      lockConnection.release();
    }
    await pool?.close();
  });
}

async function assertSqsReachable(config: AppConfig): Promise<void> {
  const client = new SQSClient({ region: config.sqs.region, endpoint: config.sqs.endpoint });
  try {
    await client.send(new GetQueueUrlCommand({ QueueName: config.sqs.wagerQueueName }), {
      abortSignal: AbortSignal.timeout(preflightTimeoutMs),
    });
  } catch (error) {
    throw new Error(`SQS inacessível em ${config.sqs.endpoint ?? "AWS"}: ${infrastructureHint}`, { cause: error });
  } finally {
    client.destroy();
  }
}
