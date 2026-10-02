import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { TransactionRunner } from "../../../application/ports/transaction-runner";

@Injectable()
export class MikroOrmTransactionRunner extends TransactionRunner {
  constructor(private readonly em: EntityManager) {
    super();
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.em.transactional(() => work());
  }
}
