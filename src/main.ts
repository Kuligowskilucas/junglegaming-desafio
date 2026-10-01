import "reflect-metadata";
import { createApp } from "./app.factory";
import { AppConfig, InvalidConfigError } from "./infrastructure/config/app-config";

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
const app = await createApp(config);
await app.listen(config.http.port);
