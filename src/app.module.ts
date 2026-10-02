import { Module, type DynamicModule } from "@nestjs/common";
import type { DestinationStream } from "pino";
import type { AppConfig } from "./infrastructure/config/app-config";
import { ConfigModule } from "./infrastructure/config/config.module";
import { LoggingModule } from "./infrastructure/observability/logging.module";
import { MetricsModule } from "./infrastructure/observability/metrics.module";
import { HealthModule } from "./interfaces/http/health/health.module";
import { MetricsHttpModule } from "./interfaces/http/metrics/metrics-http.module";
import { WageringModule } from "./interfaces/http/wagering/wagering.module";
import { WalletsModule } from "./interfaces/http/wallets/wallets.module";
import { SqsConsumerModule } from "./interfaces/sqs/sqs-consumer.module";
import { WorkersModule } from "./interfaces/workers/workers.module";

export interface AppOptions {
  logDestination?: DestinationStream;
}

@Module({})
export class AppModule {
  static register(config: AppConfig, options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule.forRoot(options.logDestination),
        MetricsModule,
        HealthModule,
        MetricsHttpModule,
        WalletsModule,
        WageringModule,
        SqsConsumerModule,
        WorkersModule,
      ],
    };
  }
}
