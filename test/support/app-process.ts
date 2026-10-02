import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { LogLine } from "./log-capture";
import { type MetricsSnapshot, scrapeMetrics } from "./metrics";

export interface AppProcessExit {
  code: number | null;
  signal: string | null;
}

const projectRoot = join(import.meta.dir, "..", "..");
const runDirectory = join(tmpdir(), "wagering-multiprocess", new Date().toISOString().replace(/[:.]/g, "-"));
const running = new Set<AppProcess>();
const readyTimeoutMs = 20_000;
const testProcessMarker = "--wagering-test-instance";
const exitTimeoutMs = 25_000;

process.once("exit", () => {
  for (const app of running) {
    app.forceKill();
  }
});

export function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

export function appEnvironment(overrides: Record<string, string>): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    LOG_LEVEL: "info",
    DB_POOL_MAX: "6",
    SQS_WAIT_TIME_SECONDS: "1",
    SQS_RETRY_BASE_SECONDS: "1",
    SQS_RETRY_MAX_SECONDS: "1",
    OUTBOX_POLL_INTERVAL_MS: "100",
    REFERENCE_WORKER_POLL_INTERVAL_MS: "100",
    SQS_CONSUMER_ENABLED: "false",
    OUTBOX_PUBLISHER_ENABLED: "false",
    REFERENCE_WORKER_ENABLED: "false",
    ...overrides,
  };
}

export class AppProcess {
  private readonly exit: Promise<AppProcessExit>;
  private exitInfo: AppProcessExit | undefined;

  private constructor(
    readonly name: string,
    readonly baseUrl: string,
    readonly logPath: string,
    private readonly subprocess: Subprocess,
  ) {
    this.exit = subprocess.exited.then(() => {
      this.exitInfo = { code: subprocess.exitCode, signal: subprocess.signalCode };
      running.delete(this);
      return this.exitInfo;
    });
  }

  static async start(name: string, overrides: Record<string, string> = {}): Promise<AppProcess> {
    mkdirSync(runDirectory, { recursive: true });
    const port = freePort();
    const logPath = join(runDirectory, `${name}-${port}.log`);
    const subprocess = Bun.spawn([process.execPath, "src/main.ts", testProcessMarker], {
      cwd: projectRoot,
      env: appEnvironment({ ...overrides, HTTP_PORT: String(port) }),
      stdout: Bun.file(logPath),
      stderr: "inherit",
    });
    const app = new AppProcess(name, `http://127.0.0.1:${port}`, logPath, subprocess);
    running.add(app);
    await app.waitUntilReady();
    return app;
  }

  static startMany(count: number, prefix: string, overrides: Record<string, string> = {}): Promise<AppProcess[]> {
    return Promise.all(Array.from({ length: count }, (_, index) => AppProcess.start(`${prefix}-${index + 1}`, overrides)));
  }

  static async stopAll(): Promise<void> {
    await Promise.all([...running].map((app) => app.kill()));
  }

  get pid(): number {
    return this.subprocess.pid;
  }

  get isRunning(): boolean {
    return this.exitInfo === undefined;
  }

  get exited(): Promise<AppProcessExit> {
    return this.exit;
  }

  async terminate(): Promise<AppProcessExit> {
    this.subprocess.kill("SIGTERM");
    const exit = await Promise.race([this.exit, Bun.sleep(exitTimeoutMs).then(() => undefined)]);
    if (exit === undefined) {
      this.forceKill();
      throw new Error(`${this.name} did not stop within ${exitTimeoutMs} ms after SIGTERM\n${await this.logTail()}`);
    }
    return exit;
  }

  kill(): Promise<AppProcessExit> {
    this.forceKill();
    return this.exit;
  }

  forceKill(): void {
    if (this.isRunning) {
      this.subprocess.kill("SIGKILL");
    }
  }

  metrics(): Promise<MetricsSnapshot> {
    return scrapeMetrics(this.baseUrl);
  }

  async logLines(): Promise<LogLine[]> {
    const text = await Bun.file(this.logPath).text();
    return text.split("\n").flatMap((line) => {
      if (!line.startsWith("{")) {
        return [];
      }
      try {
        return [JSON.parse(line) as LogLine];
      } catch {
        return [];
      }
    });
  }

  async logTail(lines = 30): Promise<string> {
    const text = await Bun.file(this.logPath).text();
    return `--- ${this.name} (${this.logPath}) ---\n${text.split("\n").slice(-lines).join("\n")}`;
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.isRunning) {
        throw new Error(`${this.name} exited before becoming ready ${JSON.stringify(this.exitInfo)}\n${await this.logTail()}`);
      }
      try {
        const response = await fetch(`${this.baseUrl}/health/ready`, { signal: AbortSignal.timeout(1_000) });
        if (response.status === 200) {
          return;
        }
      } catch {}
      await Bun.sleep(100);
    }
    this.forceKill();
    throw new Error(`${this.name} was not ready within ${readyTimeoutMs} ms\n${await this.logTail()}`);
  }
}

export async function logTails(apps: AppProcess[]): Promise<string> {
  return (await Promise.all(apps.map((app) => app.logTail()))).join("\n");
}
