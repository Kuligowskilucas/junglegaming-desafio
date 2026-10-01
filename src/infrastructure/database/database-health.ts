import { MikroORM } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";

@Injectable()
export class DatabaseHealth {
  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    await this.orm.em.getConnection().execute("select 1");
  }
}
