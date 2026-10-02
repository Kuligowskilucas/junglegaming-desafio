import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "../../src/app.factory";
import { AppConfig } from "../../src/infrastructure/config/app-config";
import { testLogSink } from "./log-capture";

export type TestApp = {
  app: INestApplication;
  baseUrl: string;
};

export async function createTestApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  const app = await createApp(AppConfig.fromEnv({ ...process.env, ...envOverrides }), { logDestination: testLogSink });
  await app.listen(0, "127.0.0.1");
  const server: Server = app.getHttpServer();
  const { port } = server.address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}
