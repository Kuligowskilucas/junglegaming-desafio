import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { DuplicateWagerTransactionError } from "../../../application/errors";
import { WagerTransactionRepository } from "../../../application/ports/wager-transaction-repository";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status";
import { isUniqueViolationOf } from "../constraint-violation";
import { wagerTransactionMapper } from "../mappers/wager-transaction.mapper";
import { WagerTransactionRecord } from "../records/wager-transaction.record";

@Injectable()
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionRecord, wagerTransactionMapper.toRecord(transaction));
    } catch (error) {
      if (isUniqueViolationOf(error, "wager_transactions_idempotency_key")) {
        throw new DuplicateWagerTransactionError("IDEMPOTENCY_KEY");
      }
      if (isUniqueViolationOf(error, "wager_transactions_external_id_key")) {
        throw new DuplicateWagerTransactionError("EXTERNAL_TRANSACTION_ID");
      }
      throw error;
    }
  }

  findById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id: transactionId });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    const reversals = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return reversals > 0;
  }

  private async findOne(
    where: Partial<Pick<WagerTransactionRecord, "id" | "providerId" | "idempotencyKey" | "externalTransactionId">>,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { refresh: true });
    return record ? wagerTransactionMapper.toDomain(record) : undefined;
  }
}
