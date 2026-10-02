import { type INestApplication, StandardSchemaValidationPipe } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule, type AppOptions } from "./app.module";
import type { AppConfig } from "./infrastructure/config/app-config";
import { ProblemDetailsFilter } from "./interfaces/http/errors/problem-details.filter";
import { RequestValidationError } from "./interfaces/http/errors/request-validation.error";

export async function createApp(config: AppConfig, options: AppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config, options), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({ exceptionFactory: (issues) => new RequestValidationError(issues) }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost)));
  app.enableShutdownHooks();
  return app;
}
