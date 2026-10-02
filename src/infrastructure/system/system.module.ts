import { Module } from "@nestjs/common";
import { Clock } from "../../application/ports/clock";
import { IdGenerator } from "../../application/ports/id-generator";
import { SystemClock } from "./system-clock";
import { UuidV7IdGenerator } from "./uuid-v7-id-generator";

@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7IdGenerator },
  ],
  exports: [Clock, IdGenerator],
})
export class SystemModule {}
