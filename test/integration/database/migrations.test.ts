import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import { connectSql, initOrm, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";

useIntegrationEnvironment();

interface SchemaObjects {
  tables: string[];
  constraints: string[];
  indexes: string[];
  triggers: string[];
  functions: string[];
}

async function schemaObjects(sql: SQL): Promise<SchemaObjects> {
  const names = async (query: Promise<{ name: string }[]>) => (await query).map((row) => row.name).sort();
  return {
    tables: await names(sql`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'`),
    constraints: await names(sql`
      SELECT c.conname AS name FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public' AND c.conrelid <> 'mikro_orm_migrations'::regclass`),
    indexes: await names(sql`
      SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'`),
    triggers: await names(sql`
      SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal`),
    functions: await names(sql`
      SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`),
  };
}

describe("migrations", () => {
  let orm: MikroORM;
  let sql: SQL;

  beforeAll(async () => {
    await resetDatabase();
    orm = await initOrm();
    sql = connectSql();
  });

  afterAll(async () => {
    await sql.close();
    await orm.close();
  });

  test("up, step-by-step down to zero and up again leave the schema identical", async () => {
    const afterFirstUp = await schemaObjects(sql);

    expect(afterFirstUp.tables).toEqual([
      "inbox_messages",
      "outbox_messages",
      "wager_transactions",
      "wallet_ledger_entries",
      "wallets",
    ]);
    expect(afterFirstUp.constraints).toEqual(
      expect.arrayContaining([
        "wallets_player_currency_key",
        "wallets_balance_non_negative",
        "wager_transactions_idempotency_key",
        "wager_transactions_external_id_key",
        "wallet_ledger_entries_one_per_transaction",
        "wallet_ledger_entries_arithmetic",
        "wallet_ledger_entries_wallet_version_key",
        "inbox_messages_pkey",
        "outbox_messages_payload_envelope",
        "outbox_messages_ordering_key_bounds",
        "wager_transactions_correlation_id_bounds",
      ]),
    );
    expect(afterFirstUp.indexes).toEqual(
      expect.arrayContaining([
        "wager_transactions_one_reversal_per_reference",
        "wager_transactions_pending_reference_due",
        "outbox_messages_pending_due",
        "outbox_messages_pending_by_ordering_key",
        "wager_transactions_waiting_for_reference",
      ]),
    );
    expect(afterFirstUp.triggers).toEqual([
      "outbox_messages_guard",
      "outbox_messages_guard_truncate",
      "wager_transactions_guard",
      "wager_transactions_guard_truncate",
      "wallet_ledger_entries_append_only",
      "wallet_ledger_entries_append_only_truncate",
      "wallet_ledger_entries_chained",
      "wallet_ledger_entries_match_transaction",
      "wallets_balance_matches_ledger",
      "wallets_guard_update",
    ]);

    const executed = await orm.migrator.getExecuted();
    expect(executed).toHaveLength(7);

    for (let remaining = executed.length - 1; remaining >= 0; remaining -= 1) {
      await orm.migrator.down();
      expect(await orm.migrator.getExecuted()).toHaveLength(remaining);
    }

    expect(await schemaObjects(sql)).toEqual({
      tables: [],
      constraints: [],
      indexes: [],
      triggers: [],
      functions: [],
    });

    await orm.migrator.up();

    expect(await schemaObjects(sql)).toEqual(afterFirstUp);
  });
});
