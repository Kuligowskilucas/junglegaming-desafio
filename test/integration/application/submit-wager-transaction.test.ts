import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import { DuplicateExternalTransactionError, IdempotencyConflictError } from "../../../src/application/errors";
import {
  type SubmitWagerTransactionCommand,
  SubmitWagerTransaction,
} from "../../../src/application/wagering/submit-wager-transaction";
import type { WagerTransaction } from "../../../src/domain/wagering/wager-transaction";
import { MikroOrmWagerTransactionRepository } from "../../../src/infrastructure/database/repositories/mikro-orm-wager-transaction.repository";
import { SystemClock } from "../../../src/infrastructure/system/system-clock";
import { UuidV7IdGenerator } from "../../../src/infrastructure/system/uuid-v7-id-generator";
import { connectSql, initOrm, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import { openWallet, repositories } from "../../support/persistence";

useIntegrationEnvironment();

class RepositoryThatMissesTheFirstLookups extends MikroOrmWagerTransactionRepository {
  private remainingMisses = 2;

  override async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    if (this.remainingMisses > 0) {
      this.remainingMisses -= 1;
      return undefined;
    }
    return super.findByIdempotencyKey(providerId, idempotencyKey);
  }
}

describe("SubmitWagerTransaction when the unique index catches a duplicate", () => {
  let orm: MikroORM;
  let sql: SQL;

  const useCase = (transactions = repositories(orm).transactions) => {
    const repos = repositories(orm);
    return new SubmitWagerTransaction(
      repos.wallets,
      transactions,
      repos.ledger,
      repos.outbox,
      repos.runner,
      new SystemClock(),
      new UuidV7IdGenerator(),
    );
  };

  const raceLoser = () => useCase(new RepositoryThatMissesTheFirstLookups(repositories(orm).em));

  const command = (walletId: string, playerId: string, overrides: Partial<SubmitWagerTransactionCommand["payload"]> = {}) => {
    const externalTransactionId = `bet-${Bun.randomUUIDv7()}`;
    return {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      correlationId: "test",
      payload: {
        providerId: "provider-a",
        externalTransactionId,
        playerId,
        walletId,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
        ...overrides,
      },
    } satisfies SubmitWagerTransactionCommand;
  };

  beforeAll(async () => {
    await resetDatabase();
    orm = await initOrm();
    sql = connectSql();
  });

  afterAll(async () => {
    await assertAllWalletsMatchLedger(sql);
    await sql.close();
    await orm.close();
  });

  test("an identical request that only meets the winner at the unique index becomes a replay", async () => {
    const wallet = await openWallet(orm, "100.00");
    const submission = command(wallet.id, wallet.playerId);
    const winner = await useCase().execute(submission);

    const loser = await raceLoser().execute(submission);

    expect(loser.idempotentReplay).toBe(true);
    expect(loser.transaction.id).toBe(winner.transaction.id);
    expect(loser.transaction.observedBalance?.toJSON().amount).toBe("90.00");
    expect((await repositories(orm).wallets.findById(wallet.id))?.balance.toJSON().amount).toBe("90.00");
  });

  test("the same key with another payload that only meets the winner at the unique index is a conflict", async () => {
    const wallet = await openWallet(orm, "100.00");
    const submission = command(wallet.id, wallet.playerId);
    const winner = await useCase().execute(submission);

    const loser = raceLoser().execute({ ...submission, payload: { ...submission.payload, money: { amount: "11.00", currency: "BRL" } } });

    await expect(loser).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(loser).rejects.toMatchObject({ existingTransactionId: winner.transaction.id });
    expect((await repositories(orm).wallets.findById(wallet.id))?.balance.toJSON().amount).toBe("90.00");
  });

  test("the same external id under another key is reported as a duplicate", async () => {
    const wallet = await openWallet(orm, "100.00");
    const submission = command(wallet.id, wallet.playerId);
    const winner = await useCase().execute(submission);

    const duplicate = useCase().execute({ ...submission, idempotencyKey: `another-${Bun.randomUUIDv7()}` });

    await expect(duplicate).rejects.toBeInstanceOf(DuplicateExternalTransactionError);
    await expect(duplicate).rejects.toMatchObject({ existingTransactionId: winner.transaction.id });
  });
});
