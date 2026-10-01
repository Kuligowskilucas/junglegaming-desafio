import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, type TestApp } from "../support/create-test-app";
import { useIntegrationEnvironment } from "../support/integration";

useIntegrationEnvironment();

describe("health endpoints with real PostgreSQL and SQS", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  test("GET /health/live answers 200 without touching dependencies", async () => {
    const response = await fetch(`${testApp.baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("GET /health/ready answers 200 when PostgreSQL and SQS are reachable", async () => {
    const response = await fetch(`${testApp.baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { postgres: { status: "up" }, sqs: { status: "up" } },
    });
  });

  test("echoes a valid x-correlation-id and generates one otherwise", async () => {
    const echoed = await fetch(`${testApp.baseUrl}/health/live`, {
      headers: { "x-correlation-id": "provider-a:req-42" },
    });
    const generated = await fetch(`${testApp.baseUrl}/health/live`, {
      headers: { "x-correlation-id": "invalid id with spaces" },
    });

    expect(echoed.headers.get("x-correlation-id")).toBe("provider-a:req-42");
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("health endpoints when SQS is unreachable", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ SQS_ENDPOINT: "http://127.0.0.1:1" });
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  test("GET /health/live still answers 200", async () => {
    const response = await fetch(`${testApp.baseUrl}/health/live`);

    expect(response.status).toBe(200);
  });

  test("GET /health/ready answers 503 flagging only SQS as down", async () => {
    const response = await fetch(`${testApp.baseUrl}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unavailable",
      checks: {
        postgres: { status: "up" },
        sqs: { status: "down", reason: expect.stringMatching(/^(timeout|unavailable)$/) },
      },
    });
  });
});
