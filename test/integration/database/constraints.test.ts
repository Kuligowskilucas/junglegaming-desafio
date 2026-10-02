import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status";
import type { Wallet } from "../../../src/domain/wallet/wallet";
import { connectSql, expectConstraintViolation, initOrm, resetDatabase } from "../../support/database";
import { useIntegrationEnvironment } from "../../support/integration";
import { type AppliedTransaction, applyTransaction, openWallet } from "../../support/persistence";

useIntegrationEnvironment();

const literal = (value: string) => `'${value}'`;
const newId = () => literal(Bun.randomUUIDv7());
const hexHash = literal("a".repeat(64));

function insert(table: string, values: Record<string, string>): string {
  return `INSERT INTO ${table} (${Object.keys(values).join(", ")}) VALUES (${Object.values(values).join(", ")})`;
}

describe("schema constraints violated directly through SQL", () => {
  let orm: MikroORM;
  let sql: SQL;
  let wallet: Wallet;
  let otherWalletOpeningId: string;
  let bet: AppliedTransaction;
  let loss: AppliedTransaction;
  let pendingRollback: AppliedTransaction;
  let pendingOutboxId: string;
  let publishedOutboxId: string;

  const walletRow = (overrides: Record<string, string> = {}) =>
    insert("wallets", {
      id: newId(),
      player_id: newId(),
      currency: "'BRL'",
      balance: "0.00",
      version: "1",
      created_at: "now()",
      updated_at: "now()",
      ...overrides,
    });

  const transactionRow = (overrides: Record<string, string> = {}) => {
    const externalId = `bet-${Bun.randomUUIDv7()}`;
    return insert("wager_transactions", {
      id: newId(),
      provider_id: "'provider-a'",
      external_transaction_id: literal(externalId),
      idempotency_key: literal(`provider-a:${externalId}`),
      correlation_id: "'correlation-test'",
      payload_hash: hexHash,
      wallet_id: literal(wallet.id),
      player_id: literal(wallet.playerId),
      round_id: "'round-1'",
      game_id: "'fortune-chimp'",
      kind: "'BET'",
      amount: "10.00",
      currency: "'BRL'",
      reference_external_transaction_id: "NULL",
      status: "'PENDING'",
      reference_transaction_id: "NULL",
      failure_code: "NULL",
      observed_balance: "NULL",
      reference_attempts: "0",
      next_reference_attempt_at: "NULL",
      created_at: "now()",
      updated_at: "now()",
      processed_at: "NULL",
      ...overrides,
    });
  };

  const ledgerRow = (overrides: Record<string, string> = {}) =>
    insert("wallet_ledger_entries", {
      id: newId(),
      wallet_id: literal(wallet.id),
      wallet_version: "99",
      transaction_id: literal(loss.transaction.id),
      direction: "'CREDIT'",
      amount: "10.00",
      currency: "'BRL'",
      balance_before: "90.00",
      balance_after: "100.00",
      created_at: "now()",
      ...overrides,
    });

  const inboxRow = (overrides: Record<string, string> = {}) =>
    insert("inbox_messages", {
      consumer_name: "'wager-transactions'",
      message_id: literal(`msg-${Bun.randomUUIDv7()}`),
      payload_hash: hexHash,
      received_at: "now()",
      processed_at: "NULL",
      ...overrides,
    });

  const outboxRow = (overrides: { id?: string; eventType?: string; payloadEventId?: string; columns?: Record<string, string> } = {}) => {
    const id = overrides.id ?? Bun.randomUUIDv7();
    const aggregateId = Bun.randomUUIDv7();
    const eventType = overrides.eventType ?? "WalletBalanceChanged";
    return insert("outbox_messages", {
      id: literal(id),
      aggregate_id: literal(aggregateId),
      ordering_key: literal(aggregateId),
      event_type: literal(eventType),
      payload: `jsonb_build_object('eventId', ${literal(overrides.payloadEventId ?? id)}, 'eventType', ${literal(eventType)}, 'aggregateId', ${literal(aggregateId)})`,
      occurred_at: "now()",
      attempts: "0",
      next_attempt_at: "NULL",
      published_at: "NULL",
      ...overrides.columns,
    });
  };

  const violate = (statement: string, constraint: string) =>
    expectConstraintViolation(
      sql.begin((tx) => tx.unsafe(statement)),
      constraint,
    );

  beforeAll(async () => {
    await resetDatabase();
    orm = await initOrm();
    sql = connectSql();
    wallet = await openWallet(orm, "100.00");
    const otherWallet = await openWallet(orm, "50.00");
    bet = await applyTransaction(orm, wallet.id, WagerTransactionKind.Bet, "10.00");
    await applyTransaction(orm, wallet.id, WagerTransactionKind.Refund, "10.00", { reference: bet.transaction });
    loss = await applyTransaction(orm, wallet.id, WagerTransactionKind.Loss, "0.00");
    pendingRollback = await applyTransaction(orm, wallet.id, WagerTransactionKind.Rollback, "10.00", {
      overrides: { referenceExternalTransactionId: "never-arrives" },
    });
    const [opening] = await sql`
      SELECT id FROM wager_transactions WHERE wallet_id = ${otherWallet.id} AND kind = 'OPENING'`;
    otherWalletOpeningId = opening.id;
    const outbox = await sql`SELECT id FROM outbox_messages WHERE aggregate_id = ${otherWallet.id}`;
    publishedOutboxId = outbox[0].id;
    pendingOutboxId = (await sql`SELECT id FROM outbox_messages WHERE aggregate_id = ${wallet.id}`)[0].id;
    await sql`UPDATE outbox_messages SET published_at = now() WHERE id = ${publishedOutboxId}`;
    await sql.unsafe(inboxRow({ message_id: "'msg-seeded'" }));
  });

  afterAll(async () => {
    await sql.close();
    await orm.close();
  });

  test("the seeded data went through the real persistence path", () => {
    expect(bet.outcome.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.outcome.status).toBe(WagerTransactionStatus.Processed);
    expect(pendingRollback.outcome.status).toBe(WagerTransactionStatus.PendingReference);
  });

  describe("wallets", () => {
    test.each<[string, () => string]>([
      ["wallets_player_currency_key", () => walletRow({ player_id: literal(wallet.playerId) })],
      ["wallets_currency_format", () => walletRow({ currency: "'brl'" })],
      ["wallets_version_positive", () => walletRow({ version: "0" })],
      ["wallets_timestamps_ordered", () => walletRow({ updated_at: "now() - interval '1 day'" })],
      ["wallets_balance_non_negative", () => `UPDATE wallets SET balance = -1, version = version + 1 WHERE id = ${literal(wallet.id)}`],
      ["wallets_identity_immutable", () => `UPDATE wallets SET player_id = ${newId()} WHERE id = ${literal(wallet.id)}`],
      ["wallets_version_follows_balance", () => `UPDATE wallets SET balance = balance + 1 WHERE id = ${literal(wallet.id)}`],
      ["wallets_version_follows_balance", () => `UPDATE wallets SET version = version + 1 WHERE id = ${literal(wallet.id)}`],
    ])("%s", async (constraint, statement) => {
      await violate(statement(), constraint);
    });
  });

  describe("wager_transactions", () => {
    test.each<[string, () => string]>([
      ["wager_transactions_idempotency_key", () => transactionRow({ idempotency_key: literal(bet.transaction.idempotencyKey) })],
      ["wager_transactions_external_id_key", () => transactionRow({ external_transaction_id: literal(bet.transaction.externalTransactionId) })],
      ["wager_transactions_wallet_id_fkey", () => transactionRow({ wallet_id: newId() })],
      ["wager_transactions_text_bounds", () => transactionRow({ round_id: "repeat('r', 129)" })],
      ["wager_transactions_payload_hash_format", () => transactionRow({ payload_hash: "'xyz'" })],
      ["wager_transactions_currency_format", () => transactionRow({ currency: "'BR'" })],
      ["wager_transactions_kind_valid", () => transactionRow({ kind: "'JACKPOT'" })],
      ["wager_transactions_status_valid", () => transactionRow({ status: "'DONE'" })],
      ["wager_transactions_failure_code_valid", () => transactionRow({ status: "'REJECTED'", failure_code: "'NOPE'", observed_balance: "1.00" })],
      ["wager_transactions_amount_by_kind", () => transactionRow({ amount: "0.00" })],
      ["wager_transactions_reference_by_kind", () => transactionRow({ kind: "'REFUND'" })],
      ["wager_transactions_reference_by_kind", () => transactionRow({ reference_external_transaction_id: "'bet-0'" })],
      ["wager_transactions_no_self_reference", () => transactionRow({ kind: "'WIN'", external_transaction_id: "'win-self'", reference_external_transaction_id: "'win-self'" })],
      ["wager_transactions_opening_is_internal", () => transactionRow({ kind: "'OPENING'" })],
      ["wager_transactions_opening_is_internal", () => transactionRow({ provider_id: "'internal'" })],
      ["wager_transactions_resolved_reference", () => transactionRow({ kind: "'REFUND'", reference_external_transaction_id: "'bet-0'", status: "'PROCESSED'", processed_at: "now()", observed_balance: "1.00" })],
      ["wager_transactions_failure_code_by_status", () => transactionRow({ status: "'REJECTED'", observed_balance: "1.00" })],
      ["wager_transactions_failure_code_by_status", () => transactionRow({ status: "'FAILED'", failure_code: "'INSUFFICIENT_FUNDS'" })],
      ["wager_transactions_failure_code_by_status", () => transactionRow({ failure_code: "'INSUFFICIENT_FUNDS'" })],
      ["wager_transactions_processed_at_by_status", () => transactionRow({ status: "'PROCESSED'", observed_balance: "1.00" })],
      ["wager_transactions_observed_balance_by_status", () => transactionRow({ status: "'PROCESSED'", processed_at: "now()" })],
      ["wager_transactions_observed_balance_by_status", () => transactionRow({ observed_balance: "1.00" })],
      ["wager_transactions_reference_schedule_by_status", () => transactionRow({ kind: "'ROLLBACK'", reference_external_transaction_id: "'bet-0'", status: "'PENDING_REFERENCE'" })],
      ["wager_transactions_reference_attempts_non_negative", () => transactionRow({ reference_attempts: "-1" })],
      ["wager_transactions_timestamps_ordered", () => transactionRow({ updated_at: "now() - interval '1 day'" })],
      ["wager_transactions_correlation_id_bounds", () => transactionRow({ correlation_id: "''" })],
      ["wager_transactions_payload_immutable", () => `UPDATE wager_transactions SET correlation_id = 'rewritten' WHERE id = ${literal(pendingRollback.transaction.id)}`],
      ["wager_transactions_one_reversal_per_reference", () => transactionRow({ kind: "'ROLLBACK'", reference_external_transaction_id: literal(bet.transaction.externalTransactionId), status: "'PROCESSED'", reference_transaction_id: literal(bet.transaction.id), processed_at: "now()", observed_balance: "1.00" })],
      ["wager_transactions_terminal_immutable", () => `UPDATE wager_transactions SET updated_at = updated_at + interval '1 second' WHERE id = ${literal(bet.transaction.id)}`],
      ["wager_transactions_payload_immutable", () => `UPDATE wager_transactions SET amount = 11.00 WHERE id = ${literal(pendingRollback.transaction.id)}`],
      ["wager_transactions_transition_valid", () => `UPDATE wager_transactions SET status = 'PENDING', next_reference_attempt_at = NULL WHERE id = ${literal(pendingRollback.transaction.id)}`],
      ["wager_transactions_transition_valid", () => `UPDATE wager_transactions SET reference_attempts = 0 WHERE id = ${literal(pendingRollback.transaction.id)}`],
      ["wager_transactions_append_only", () => `DELETE FROM wager_transactions WHERE id = ${literal(pendingRollback.transaction.id)}`],
      ["wager_transactions_append_only", () => "TRUNCATE wager_transactions, wallet_ledger_entries"],
    ])("%s", async (constraint, statement) => {
      await violate(statement(), constraint);
    });
  });

  describe("wallet_ledger_entries", () => {
    test.each<[string, () => string]>([
      ["wallet_ledger_entries_one_per_transaction", () => ledgerRow({ transaction_id: literal(bet.transaction.id) })],
      ["wallet_ledger_entries_wallet_version_key", () => ledgerRow({ wallet_version: "1" })],
      ["wallet_ledger_entries_direction_valid", () => ledgerRow({ direction: "'SIDEWAYS'", balance_after: "80.00" })],
      ["wallet_ledger_entries_amount_positive", () => ledgerRow({ amount: "0.00", balance_after: "90.00" })],
      ["wallet_ledger_entries_balances_non_negative", () => ledgerRow({ balance_before: "-10.00", balance_after: "0.00" })],
      ["wallet_ledger_entries_wallet_version_positive", () => ledgerRow({ wallet_version: "0" })],
      ["wallet_ledger_entries_arithmetic", () => ledgerRow({ balance_after: "100.01" })],
      ["wallet_ledger_entries_wallet_currency_fkey", () => ledgerRow({ currency: "'USD'" })],
      ["wallet_ledger_entries_transaction_wallet_fkey", () => ledgerRow({ transaction_id: literal(otherWalletOpeningId) })],
      ["wallet_ledger_entries_append_only", () => `UPDATE wallet_ledger_entries SET amount = amount WHERE wallet_id = ${literal(wallet.id)}`],
      ["wallet_ledger_entries_append_only", () => `DELETE FROM wallet_ledger_entries WHERE wallet_id = ${literal(wallet.id)}`],
      ["wallet_ledger_entries_append_only", () => "TRUNCATE wallet_ledger_entries"],
    ])("%s", async (constraint, statement) => {
      await violate(statement(), constraint);
    });

    test("TRUNCATE wallets CASCADE cannot wipe the ledger or the transactions either", async () => {
      const failure = await sql
        .begin((tx) => tx.unsafe("TRUNCATE wallets CASCADE"))
        .then(() => undefined, (error: { constraint?: string }) => error);

      expect(["wager_transactions_append_only", "wallet_ledger_entries_append_only", "outbox_messages_retention"]).toContain(
        failure?.constraint ?? "",
      );
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM wallet_ledger_entries`;
      expect(count).toBeGreaterThan(0);
    });
  });

  describe("inbox_messages", () => {
    test.each<[string, () => string]>([
      ["inbox_messages_pkey", () => inboxRow({ message_id: "'msg-seeded'" })],
      ["inbox_messages_text_bounds", () => inboxRow({ message_id: "repeat('m', 257)" })],
      ["inbox_messages_payload_hash_format", () => inboxRow({ payload_hash: "'xyz'" })],
      ["inbox_messages_processed_after_received", () => inboxRow({ processed_at: "now() - interval '1 day'" })],
    ])("%s", async (constraint, statement) => {
      await violate(statement(), constraint);
    });
  });

  describe("outbox_messages", () => {
    test.each<[string, () => string]>([
      ["outbox_messages_event_type_format", () => outboxRow({ eventType: "wallet balance" })],
      ["outbox_messages_payload_envelope", () => outboxRow({ payloadEventId: Bun.randomUUIDv7() })],
      ["outbox_messages_attempts_non_negative", () => outboxRow({ columns: { attempts: "-1" } })],
      ["outbox_messages_ordering_key_bounds", () => outboxRow({ columns: { ordering_key: "repeat('k', 129)" } })],
      ["outbox_messages_content_immutable", () => `UPDATE outbox_messages SET ordering_key = 'another-wallet' WHERE id = ${literal(pendingOutboxId)}`],
      ["outbox_messages_published_has_no_schedule", () => outboxRow({ columns: { published_at: "now()", next_attempt_at: "now()" } })],
      ["outbox_messages_retention", () => `DELETE FROM outbox_messages WHERE id = ${literal(pendingOutboxId)}`],
      ["outbox_messages_retention", () => "TRUNCATE outbox_messages"],
      ["outbox_messages_content_immutable", () => `UPDATE outbox_messages SET payload = payload || '{"extra": 1}' WHERE id = ${literal(pendingOutboxId)}`],
      ["outbox_messages_published_once", () => `UPDATE outbox_messages SET attempts = attempts + 1 WHERE id = ${literal(publishedOutboxId)}`],
    ])("%s", async (constraint, statement) => {
      await violate(statement(), constraint);
    });

    test("a published message may be deleted for retention", async () => {
      await sql`DELETE FROM outbox_messages WHERE id = ${publishedOutboxId}`;

      expect(await sql`SELECT id FROM outbox_messages WHERE id = ${publishedOutboxId}`).toHaveLength(0);
    });
  });
});
