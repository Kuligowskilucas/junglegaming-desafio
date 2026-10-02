import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
  type LedgerPageRequest,
  type LedgerSummary,
  WalletLedgerRepository,
} from "../../../application/ports/wallet-ledger-repository";
import { Money } from "../../../domain/shared/money";
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

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const row = await this.em
      .getKysely<LedgerDatabase>()
      .selectFrom("wallet_ledger_entries")
      .select((eb) => [
        eb
          .cast<string>(
            eb.fn.coalesce(
              eb.fn.sum(
                eb.case().when("direction", "=", "CREDIT").then(eb.ref("amount")).else(eb.neg(eb.ref("amount"))).end(),
              ),
              eb.lit(0),
            ),
            "text",
          )
          .as("balance"),
        eb.fn.countAll<string>().as("entries"),
      ])
      .where("wallet_id", "=", walletId)
      .executeTakeFirstOrThrow();
    return { balance: signedMoney(String(row.balance), currency), entries: Number(row.entries) };
  }
}

interface LedgerDatabase {
  wallet_ledger_entries: {
    wallet_id: string;
    direction: string;
    amount: string;
  };
}

function signedMoney(amount: string, currency: string): Money {
  const negative = amount.startsWith("-");
  const absolute = negative ? amount.slice(1) : amount;
  const money = Money.from({ amount: absolute.includes(".") ? absolute : `${absolute}.00`, currency });
  return negative ? money.negate() : money;
}
