import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { WagerTransactionRepository } from "../../../application/ports/wager-transaction-repository";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import { wagerTransactionMapper } from "../mappers/wager-transaction.mapper";
import { WagerTransactionRecord } from "../records/wager-transaction.record";

@Injectable()
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, wagerTransactionMapper.toRecord(transaction));
  }
}
