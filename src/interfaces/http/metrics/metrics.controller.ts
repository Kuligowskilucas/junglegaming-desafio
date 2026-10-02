import { Controller, Get, Res } from "@nestjs/common";
import { Registry } from "prom-client";
import { BacklogGauges } from "../../../infrastructure/observability/backlog-gauges";

@Controller("metrics")
export class MetricsController {
  constructor(
    private readonly registry: Registry,
    private readonly backlogGauges: BacklogGauges,
  ) {}

  @Get()
  async scrape(@Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown }): Promise<string> {
    await this.backlogGauges.refresh();
    response.setHeader("Content-Type", this.registry.contentType);
    return this.registry.metrics();
  }
}
