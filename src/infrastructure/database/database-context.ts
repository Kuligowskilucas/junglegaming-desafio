import { MikroORM, RequestContext } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";

@Injectable()
export class DatabaseContext {
  constructor(private readonly orm: MikroORM) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return RequestContext.create(this.orm.em, work);
  }
}
