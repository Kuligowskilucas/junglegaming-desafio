import type { MikroORM } from "@mikro-orm/postgresql";
import { OpenWallet } from "../../src/application/wallet/open-wallet";
import { Money } from "../../src/domain/shared/money";
import { settleWagerTransaction, type SettlementOutcome } from "../../src/domain/wagering/wager-settlement";
import { type CreateWagerTransactionProps, WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import type { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind";
import type { Wallet } from "../../src/domain/wallet/wallet";
import { MikroOrmOutboxRepository } from "../../src/infrastructure/database/repositories/mikro-orm-outbox.repository";
import { MikroOrmTransactionRunner } from "../../src/infrastructure/database/repositories/mikro-orm-transaction-runner";
import { MikroOrmWagerTransactionRepository } from "../../src/infrastructure/database/repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletLedgerRepository } from "../../src/infrastructure/database/repositories/mikro-orm-wallet-ledger.repository";
import { MikroOrmWalletRepository } from "../../src/infrastructure/database/repositories/mikro-orm-wallet.repository";
import { SystemClock } from "../../src/infrastructure/system/system-clock";
import { UuidV7IdGenerator } from "../../src/infrastructure/system/uuid-v7-id-generator";

export function repositories(orm: MikroORM) {
  const em = orm.em.fork({ useContext: true });
  return {
    em,
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmWalletLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    runner: new MikroOrmTransactionRunner(em),
  };
}

export async function openWallet(orm: MikroORM, amount = "100.00", currency = "BRL"): Promise<Wallet> {
  const repos = repositories(orm);
  return new OpenWallet(
    repos.wallets,
    repos.transactions,
    repos.ledger,
    repos.outbox,
    repos.runner,
    new SystemClock(),
    new UuidV7IdGenerator(),
  ).execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency }, correlationId: "test" });
}

export interface AppliedTransaction {
  transaction: WagerTransaction;
  outcome: SettlementOutcome;
}

export async function applyTransaction(
  orm: MikroORM,
  walletId: string,
  kind: WagerTransactionKind,
  amount: string,
  options: { reference?: WagerTransaction; at?: Date; overrides?: Partial<CreateWagerTransactionProps> } = {},
): Promise<AppliedTransaction> {
  const repos = repositories(orm);
  const at = options.at ?? new Date();
  return repos.runner.run(async () => {
    const wallet = await repos.wallets.findByIdForUpdate(walletId);
    if (!wallet) {
      throw new Error(`wallet ${walletId} not found`);
    }
    const externalTransactionId = `${kind.toLowerCase()}-${Bun.randomUUIDv7()}`;
    const transaction = WagerTransaction.create({
      id: Bun.randomUUIDv7(),
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      correlationId: "test",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: options.reference?.roundId ?? "round-1",
      gameId: "fortune-chimp",
      kind,
      money: Money.from({ amount, currency: wallet.currency }),
      referenceExternalTransactionId: options.reference?.externalTransactionId,
      createdAt: at,
      ...options.overrides,
    });
    const outcome = settleWagerTransaction({
      transaction,
      wallet,
      reference: options.reference,
      referenceAlreadyReversed: false,
      ledgerEntryId: Bun.randomUUIDv7(),
      at,
    });
    await repos.transactions.add(transaction);
    if (outcome.status === "PROCESSED" && outcome.entry) {
      await repos.ledger.append(outcome.entry);
      await repos.wallets.update(wallet);
    }
    return { transaction, outcome };
  });
}
