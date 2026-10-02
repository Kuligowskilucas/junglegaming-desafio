import { Global, Module } from "@nestjs/common";
import { collectDefaultMetrics, Registry } from "prom-client";
import { WageringMetrics } from "./wagering-metrics";

@Global()
@Module({
  providers: [
    {
      provide: Registry,
      useFactory: () => {
        const registry = new Registry();
        collectDefaultMetrics({ register: registry });
        return registry;
      },
    },
    { provide: WageringMetrics, inject: [Registry], useFactory: (registry: Registry) => new WageringMetrics(registry) },
  ],
  exports: [Registry, WageringMetrics],
})
export class MetricsModule {}
