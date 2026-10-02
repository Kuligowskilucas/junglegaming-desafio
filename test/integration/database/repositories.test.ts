import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WalletAlreadyExistsError } from "../../../src/application/errors";
import { WalletBalanceChanged } from "../../../src/domain/events/wallet-balance-changed";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { Money } from "../../../src/domain/shared/money";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import { WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { outboxMessageMapper } from "../../../src/infrastructure/database/mappers/outbox-message.mapper";
import { wagerTransactionMapper } from "../../../src/infrastructure/database/mappers/wager-transaction.mapper";
import { OutboxMessageRecord } from "../../../src/infrastructure/database/records/outbox-message.record";
import { WagerTransactionRecord } from "../../../src/infrastructure/database/records/wager-transaction.record";
import { initOrm, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { applyTransaction, openWallet, repositories } from "../../support/persistence";

useIntegrationEnvironment();

const at = new Date("2026-10-02T12:00:00.000Z");
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("MikroORM repositories and mappers", () => {
  let orm: MikroORM;

  beforeAll(async () => {
    await resetDatabase();
    orm = await initOrm();
  });

  afterAll(async () => {
    await orm.close();
  });

  test("a wallet survives the round trip unchanged", async () => {
    const { wallet } = Wallet.open({
      id: Bun.randomUUIDv7(),
      playerId: Bun.randomUUIDv7(),
      initialBalance: brl("0.00"),
      openingTransactionId: Bun.randomUUIDv7(),
      openingEntryId: Bun.randomUUIDv7(),
      at,
    });
    const repos = repositories(orm);
    await repos.runner.run(() => repos.wallets.add(wallet));

    const loaded = await repositories(orm).wallets.findById(wallet.id);

    expect(loaded?.balance.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(loaded?.version).toBe(1);
    expect(loaded?.playerId).toBe(wallet.playerId);
    expect(loaded?.createdAt).toEqual(at);
    expect(loaded?.updatedAt).toEqual(at);
    expect(await repositories(orm).wallets.findIdByPlayerAndCurrency(wallet.playerId, "BRL")).toBe(wallet.id);
  });

  test("a second wallet for the same player and currency is reported as WalletAlreadyExistsError", async () => {
    const existing = await openWallet(orm, "10.00");
    const { wallet: duplicate } = Wallet.open({
      id: Bun.randomUUIDv7(),
      playerId: existing.playerId,
      initialBalance: brl("0.00"),
      openingTransactionId: Bun.randomUUIDv7(),
      openingEntryId: Bun.randomUUIDv7(),
      at,
    });
    const repos = repositories(orm);

    await expect(repos.runner.run(() => repos.wallets.add(duplicate))).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  test("findByIdForUpdate and update apply a real domain movement", async () => {
    const wallet = await openWallet(orm, "100.00");

    const { transaction, outcome } = await applyTransaction(orm, wallet.id, WagerTransactionKind.Bet, "25.00");

    const reloaded = await repositories(orm).wallets.findById(wallet.id);
    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    expect(reloaded?.balance.toJSON().amount).toBe("75.00");
    expect(reloaded?.version).toBe(2);
    const page = await repositories(orm).ledger.listByWallet(wallet.id, { beforeWalletVersion: undefined, limit: 10 });
    expect(page.map((entry) => [entry.walletVersion, entry.direction, entry.transactionId])).toEqual([
      [2, "DEBIT", transaction.id],
      [1, "CREDIT", expect.any(String)],
    ]);
  });

  test("findByIdForUpdate requires an open transaction", async () => {
    const wallet = await openWallet(orm, "1.00");

    await expect(repositories(orm).wallets.findByIdForUpdate(wallet.id)).rejects.toThrow();
  });

  test("listByWallet pages backwards by wallet version", async () => {
    const wallet = await openWallet(orm, "100.00");
    for (let i = 0; i < 4; i += 1) {
      await applyTransaction(orm, wallet.id, WagerTransactionKind.Win, "1.00");
    }
    const ledger = repositories(orm).ledger;

    const firstPage = await ledger.listByWallet(wallet.id, { beforeWalletVersion: undefined, limit: 2 });
    const secondPage = await ledger.listByWallet(wallet.id, { beforeWalletVersion: 4, limit: 10 });

    expect(firstPage.map((entry) => entry.walletVersion)).toEqual([5, 4]);
    expect(secondPage.map((entry) => entry.walletVersion)).toEqual([3, 2, 1]);
    expect(secondPage.at(-1)?.balanceBefore.toJSON().amount).toBe("0.00");
  });

  test("a wager transaction with every optional field survives the round trip", async () => {
    const wallet = await openWallet(orm, "100.00");
    const rejected = await applyTransaction(orm, wallet.id, WagerTransactionKind.Bet, "500.00");
    const pending = await applyTransaction(orm, wallet.id, WagerTransactionKind.Rollback, "10.00", {
      overrides: { referenceExternalTransactionId: "bet-not-yet" },
    });
    const em = orm.em.fork();

    const rejectedBack = wagerTransactionMapper.toDomain(
      await em.findOneOrFail(WagerTransactionRecord, { id: rejected.transaction.id }),
    );
    const pendingBack = wagerTransactionMapper.toDomain(
      await em.findOneOrFail(WagerTransactionRecord, { id: pending.transaction.id }),
    );

    expect(rejectedBack.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejectedBack.observedBalance?.toJSON().amount).toBe("100.00");
    expect(rejectedBack.payloadHash).toBe(rejected.transaction.payloadHash);
    expect(rejectedBack.processedAt).toBeUndefined();
    expect(pendingBack.status).toBe(pending.transaction.status);
    expect(pendingBack.referenceExternalTransactionId).toBe("bet-not-yet");
    expect(pendingBack.referenceAttempts).toBe(1);
    expect(pendingBack.nextReferenceAttemptAt).toEqual(pending.transaction.nextReferenceAttemptAt);
    expect(pendingBack.observedBalance).toBeUndefined();
  });

  test("an outbox message keeps its envelope through JSONB", async () => {
    const wallet = await openWallet(orm, "100.00");
    const em = orm.em.fork();

    const records = await em.find(OutboxMessageRecord, { aggregateId: wallet.id });
    const messages = records.map(outboxMessageMapper.toDomain);

    expect(messages).toHaveLength(1);
    const [message] = messages as [OutboxMessage];
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.isPending()).toBe(true);
    expect(message.attempts).toBe(0);
    expect(message.payload).toMatchObject({
      eventId: message.id,
      aggregateId: wallet.id,
      version: 1,
      data: { balanceAfter: { amount: "100.00", currency: "BRL" }, walletVersion: 1 },
    });
  });

  test("an outbox message written by the repository reads back equal", async () => {
    const wallet = await openWallet(orm, "100.00");
    const { transaction } = await applyTransaction(orm, wallet.id, WagerTransactionKind.Win, "5.00");
    const reloaded = await repositories(orm).wallets.findById(wallet.id);
    const entries = await repositories(orm).ledger.listByWallet(wallet.id, { beforeWalletVersion: undefined, limit: 1 });
    const message = OutboxMessage.enqueue(
      WalletBalanceChanged.from(reloaded!, entries[0]!, {
        eventId: Bun.randomUUIDv7(),
        correlationId: "test",
        occurredAt: at,
      }),
    );
    const repos = repositories(orm);
    await repos.runner.run(() => repos.outbox.add(message));

    const record = await orm.em.fork().findOneOrFail(OutboxMessageRecord, { id: message.id });

    expect(outboxMessageMapper.toDomain(record).payload).toEqual(JSON.parse(JSON.stringify(message.payload)));
    expect(entries[0]?.transactionId).toBe(transaction.id);
  });

  test("an opening transaction is stored as PROCESSED by the internal provider", async () => {
    const wallet = await openWallet(orm, "42.00");
    const record = await orm.em.fork().findOneOrFail(WagerTransactionRecord, { walletId: wallet.id });

    const opening = wagerTransactionMapper.toDomain(record);

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.providerId).toBe("internal");
    expect(opening.observedBalance?.toJSON().amount).toBe("42.00");
    expect(opening.payloadHash).toBe(
      WagerTransaction.opening({ id: opening.id, correlationId: "test", walletId: wallet.id, playerId: wallet.playerId, money: brl("42.00"), at }).payloadHash,
    );
  });
});
