import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { AppConfig } from "../config/app-config";
import { BacklogProbe } from "./backlog.probe";
import { DatabaseHealth } from "./database-health";
import { createMikroOrmOptions } from "./mikro-orm.options";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createMikroOrmOptions(config),
    }),
  ],
  providers: [DatabaseHealth, BacklogProbe],
  exports: [DatabaseHealth, BacklogProbe],
})
export class DatabaseModule {}
