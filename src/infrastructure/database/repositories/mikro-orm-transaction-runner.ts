import { IsolationLevel } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { TransactionRunner } from "../../../application/ports/transaction-runner";
import { WageringMetrics } from "../../observability/wagering-metrics";
import { lockConflictOf } from "../transient-error";

@Injectable()
export class MikroOrmTransactionRunner extends TransactionRunner {
  private readonly countedLockConflicts = new WeakSet<object>();

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: WageringMetrics,
  ) {
    super();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.em.transactional(() => work());
    } catch (error) {
      this.recordLockConflict(error);
      throw error;
    }
  }

  readSnapshot<T>(work: () => Promise<T>): Promise<T> {
    return this.em.transactional(() => work(), { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true });
  }

  private recordLockConflict(error: unknown): void {
    const conflict = lockConflictOf(error);
    if (!conflict || typeof error !== "object" || error === null || this.countedLockConflicts.has(error)) {
      return;
    }
    this.countedLockConflicts.add(error);
    this.metrics.lockConflict(conflict);
  }
}
