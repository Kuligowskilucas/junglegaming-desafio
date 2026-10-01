import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../../infrastructure/database/database.module";
import { MessagingModule } from "../../../infrastructure/messaging/messaging.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [DatabaseModule, MessagingModule],
  controllers: [HealthController],
})
export class HealthModule {}
