import { join } from "node:path";
import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import type { AppConfig } from "../config/app-config";
import { persistenceRecords } from "./records";

const migrationsPath = join(import.meta.dirname, "migrations");

export function createMikroOrmOptions(config: AppConfig) {
  return defineConfig({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    dbName: config.database.name,
    pool: { max: config.database.poolMax },
    driverOptions: { options: `-c lock_timeout=${config.database.lockTimeoutMs}` },
    entities: persistenceRecords,
    extensions: [Migrator],
    migrations: {
      path: migrationsPath,
      pathTs: migrationsPath,
      glob: "!(*.d).ts",
      snapshot: false,
    },
  });
}
