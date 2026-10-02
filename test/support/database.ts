import { expect } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQL } from "bun";
import { AppConfig } from "../../src/infrastructure/config/app-config";
import { createMikroOrmOptions } from "../../src/infrastructure/database/mikro-orm.options";

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return AppConfig.fromEnv({ ...process.env, ...overrides });
}

export function connectSql(config: AppConfig = testConfig()): SQL {
  return new SQL({
    hostname: config.database.host,
    port: config.database.port,
    username: config.database.user,
    password: config.database.password,
    database: config.database.name,
    max: 4,
  });
}

export async function initOrm(config: AppConfig = testConfig()): Promise<MikroORM> {
  const options = createMikroOrmOptions(config);
  return MikroORM.init({ ...options, migrations: { ...options.migrations, silent: true } });
}

export async function resetDatabase(): Promise<void> {
  const config = testConfig();
  if (!config.database.name.endsWith("_test")) {
    throw new Error(`Refusing to reset ${config.database.name}: only *_test databases can be reset`);
  }
  const sql = connectSql(config);
  try {
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  } finally {
    await sql.close();
  }
  const orm = await initOrm(config);
  try {
    await orm.migrator.up();
  } finally {
    await orm.close();
  }
}

export async function expectConstraintViolation(operation: Promise<unknown>, constraint: string): Promise<Error> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { constraint?: string }).constraint).toBe(constraint);
  return failure as Error;
}
