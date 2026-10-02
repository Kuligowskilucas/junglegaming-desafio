import { IdGenerator } from "../../application/ports/id-generator";

export class UuidV7IdGenerator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
