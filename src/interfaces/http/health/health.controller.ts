import { Controller, Get, Logger, Res } from "@nestjs/common";
import { AppConfig } from "../../../infrastructure/config/app-config";
import { DatabaseHealth } from "../../../infrastructure/database/database-health";
import { SqsHealth } from "../../../infrastructure/messaging/sqs-health";
import { rejectWhenAborted } from "../../../infrastructure/observability/abortable";

type DependencyStatus = { status: "up" } | { status: "down"; reason: "timeout" | "unavailable" };

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly database: DatabaseHealth,
    private readonly sqs: SqsHealth,
    private readonly config: AppConfig,
  ) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ): Promise<{ status: "ok" | "unavailable"; checks: Record<string, DependencyStatus> }> {
    const [postgres, sqs] = await Promise.all([
      this.probe("postgres", () => this.database.check()),
      this.probe("sqs", (signal) => this.sqs.check(signal)),
    ]);
    const checks = { postgres, sqs };
    if (Object.values(checks).some((check) => check.status === "down")) {
      response.status(503);
      return { status: "unavailable", checks };
    }
    return { status: "ok", checks };
  }

  private async probe(
    dependency: string,
    check: (signal: AbortSignal) => Promise<void>,
  ): Promise<DependencyStatus> {
    const signal = AbortSignal.timeout(this.config.health.timeoutMs);
    try {
      await Promise.race([check(signal), rejectWhenAborted(signal)]);
      return { status: "up" };
    } catch (error) {
      const reason = signal.aborted ? "timeout" : "unavailable";
      this.logger.warn({ dependency, reason, err: error }, "Readiness check failed");
      return { status: "down", reason };
    }
  }
}
