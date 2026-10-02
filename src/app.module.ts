import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "./infrastructure/config/app-config";
import { ConfigModule } from "./infrastructure/config/config.module";
import { LoggingModule } from "./infrastructure/observability/logging.module";
import { HealthModule } from "./interfaces/http/health/health.module";
import { WalletsModule } from "./interfaces/http/wallets/wallets.module";

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), LoggingModule, HealthModule, WalletsModule],
    };
  }
}
