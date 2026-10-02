import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../../infrastructure/database/database.module";
import { MessagingModule } from "../../../infrastructure/messaging/messaging.module";
import { BacklogGauges } from "../../../infrastructure/observability/backlog-gauges";
import { MetricsController } from "./metrics.controller";

@Module({
  imports: [DatabaseModule, MessagingModule],
  controllers: [MetricsController],
  providers: [BacklogGauges],
})
export class MetricsHttpModule {}
