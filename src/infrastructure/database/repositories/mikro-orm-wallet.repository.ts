import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import { WalletAlreadyExistsError } from "../../../application/errors";
import { WalletRepository } from "../../../application/ports/wallet-repository";
import type { Wallet } from "../../../domain/wallet/wallet";
import { isUniqueViolationOf } from "../constraint-violation";
import { walletMapper } from "../mappers/wallet.mapper";
import { WalletRecord } from "../records/wallet.record";

@Injectable()
export class MikroOrmWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, walletMapper.toRecord(wallet));
    } catch (error) {
      if (isUniqueViolationOf(error, "wallets_player_currency_key")) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency, undefined);
      }
      throw error;
    }
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id: walletId });
    return record ? walletMapper.toDomain(record) : undefined;
  }

  async findByIdForUpdate(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? walletMapper.toDomain(record) : undefined;
  }

  async update(wallet: Wallet): Promise<void> {
    const record = await this.em.findOneOrFail(WalletRecord, { id: wallet.id });
    const { balance, version, updatedAt } = walletMapper.toRecord(wallet);
    this.em.assign(record, { balance, version, updatedAt });
    await this.em.flush();
  }

  async findIdByPlayerAndCurrency(playerId: string, currency: string): Promise<string | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency }, { fields: ["id"] });
    return record?.id;
  }
}
