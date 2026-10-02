import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { type LedgerPageRequest, WalletLedgerRepository } from "../../../application/ports/wallet-ledger-repository";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import { walletLedgerEntryMapper } from "../mappers/wallet-ledger-entry.mapper";
import { WalletLedgerEntryRecord } from "../records/wallet-ledger-entry.record";

@Injectable()
export class MikroOrmWalletLedgerRepository extends WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntryRecord, walletLedgerEntryMapper.toRecord(entry));
  }

  async listByWallet(walletId: string, page: LedgerPageRequest): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      WalletLedgerEntryRecord,
      page.beforeWalletVersion === undefined
        ? { walletId }
        : { walletId, walletVersion: { $lt: page.beforeWalletVersion } },
      { orderBy: { walletVersion: "desc" }, limit: page.limit },
    );
    return records.map(walletLedgerEntryMapper.toDomain);
  }
}
