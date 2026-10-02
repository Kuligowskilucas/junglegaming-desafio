import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { stdTimeFunctions } from "pino";
import { AppConfig } from "../config/app-config";
import { isAcceptedCorrelationId } from "./correlation-id";

const correlationIdHeader = "x-correlation-id";

function correlationIdOf(request: IncomingMessage, response: ServerResponse): string {
  const received = request.headers[correlationIdHeader];
  const correlationId = isAcceptedCorrelationId(received) ? received : randomUUID();
  response.setHeader(correlationIdHeader, correlationId);
  return correlationId;
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.log.level,
          base: { service: "wagering-processor", pid: process.pid, hostname: hostname() },
          messageKey: "message",
          timestamp: stdTimeFunctions.isoTime,
          formatters: { level: (label: string) => ({ level: label }) },
          genReqId: correlationIdOf,
          customAttributeKeys: { reqId: "correlationId" },
          quietReqLogger: true,
          autoLogging: { ignore: (request: IncomingMessage) => request.url?.startsWith("/health") ?? false },
          serializers: {
            req: (request: { method: string; url: string }) => ({ method: request.method, url: request.url }),
            res: (response: { statusCode: number }) => ({ statusCode: response.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
