import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import type { LedgerSummary } from "../../../src/application/ports/wallet-ledger-repository";
import { ReconcileWallet } from "../../../src/application/wallet/reconcile-wallet";
import { MikroOrmWalletLedgerRepository } from "../../../src/infrastructure/database/repositories/mikro-orm-wallet-ledger.repository";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { connectSql, initOrm, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { assertAllWalletsMatchLedger } from "../../support/ledger-invariant";
import { repositories } from "../../support/persistence";
import { wager, WageringClient } from "../../support/wagering-client";

useIntegrationEnvironment();

class LedgerThatSeesACommitBeforeSumming extends MikroOrmWalletLedgerRepository {
  constructor(
    em: EntityManager,
    private readonly commitConcurrently: () => Promise<void>,
  ) {
    super(em);
  }

  override async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    await this.commitConcurrently();
    return super.summarize(walletId, currency);
  }
}

describe("ReconcileWallet reading one snapshot", () => {
  let orm: MikroORM;
  let sql: SQL;
  let testApp: TestApp;
  let client: WageringClient;

  beforeAll(async () => {
    await resetDatabase();
    orm = await initOrm();
    sql = connectSql();
    testApp = await createTestApp();
    client = new WageringClient(testApp.baseUrl);
  });

  afterAll(async () => {
    await assertAllWalletsMatchLedger(sql);
    await testApp.app.close();
    await sql.close();
    await orm.close();
  });

  test("a bet committed between reading the wallet and summing the ledger does not create a false divergence", async () => {
    const wallet = await client.openWallet("100.00");
    const repos = repositories(orm);
    const ledger = new LedgerThatSeesACommitBeforeSumming(repos.em, async () => {
      expect((await client.submitWager(wager(wallet, "BET", "10.00"))).status).toBe(200);
    });

    const reconciliation = await new ReconcileWallet(repos.wallets, ledger, repos.runner).execute(wallet.id);

    expect(reconciliation.toJSON()).toMatchObject({
      storedBalance: { amount: "100.00" },
      calculatedBalance: { amount: "100.00" },
      consistent: true,
      checkedEntries: 1,
    });
    expect(await client.balanceOf(wallet.id)).toBe("90.00");
  });
});
