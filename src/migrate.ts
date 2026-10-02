import { MikroORM } from "@mikro-orm/postgresql";
import { AppConfig, InvalidConfigError } from "./infrastructure/config/app-config";
import { createMikroOrmOptions } from "./infrastructure/database/mikro-orm.options";

function loadConfig(): AppConfig {
  try {
    return AppConfig.fromEnv(process.env);
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfig();
const orm = await MikroORM.init(createMikroOrmOptions(config));
try {
  const applied = await orm.migrator.up();
  console.info(
    JSON.stringify({
      level: "info",
      time: new Date().toISOString(),
      service: "wagering-processor",
      message: "Migrations applied",
      database: config.database.name,
      migrations: applied.map((migration) => migration.name),
    }),
  );
} finally {
  await orm.close();
}
