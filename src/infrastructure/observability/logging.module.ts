import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import { type DynamicModule, Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { type DestinationStream, stdTimeFunctions } from "pino";
import { AppConfig } from "../config/app-config";
import { isAcceptedCorrelationId } from "./correlation-id";
import { serializeError } from "./log-serializers";

const correlationIdHeader = "x-correlation-id";
const unloggedRoutes = ["/health", "/metrics"];

function correlationIdOf(request: IncomingMessage, response: ServerResponse): string {
  const received = request.headers[correlationIdHeader];
  const correlationId = isAcceptedCorrelationId(received) ? received : randomUUID();
  response.setHeader(correlationIdHeader, correlationId);
  return correlationId;
}

@Module({})
export class LoggingModule {
  static forRoot(destination?: DestinationStream): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        LoggerModule.forRootAsync({
          inject: [AppConfig],
          useFactory: (config: AppConfig) => {
            const options = {
              level: config.log.level,
              base: { service: "wagering-processor", pid: process.pid, hostname: hostname() },
              messageKey: "message",
              timestamp: stdTimeFunctions.isoTime,
              formatters: { level: (label: string) => ({ level: label }) },
              genReqId: correlationIdOf,
              customAttributeKeys: { reqId: "correlationId" },
              quietReqLogger: true,
              autoLogging: {
                ignore: (request: IncomingMessage) => unloggedRoutes.some((route) => request.url?.startsWith(route)),
              },
              serializers: {
                req: (request: { method: string; url: string }) => ({ method: request.method, url: request.url }),
                res: (response: { statusCode: number }) => ({ statusCode: response.statusCode }),
                err: serializeError,
              },
            };
            return {
              pinoHttp: destination === undefined ? options : [options, destination],
              assignResponse: true,
            };
          },
        }),
      ],
    };
  }
}
