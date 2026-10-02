import { Migration } from "@mikro-orm/migrations";

const wagerPayloadColumns = [
  "id",
  "provider_id",
  "external_transaction_id",
  "idempotency_key",
  "payload_hash",
  "wallet_id",
  "player_id",
  "round_id",
  "game_id",
  "kind",
  "amount",
  "currency",
  "reference_external_transaction_id",
  "created_at",
];

const outboxContentColumns = ["id", "aggregate_id", "event_type", "payload", "occurred_at"];

function row(prefix: "NEW" | "OLD", columns: string[]): string {
  return columns.map((column) => `${prefix}.${column}`).join(", ");
}

function wagerTransactionsGuard(immutableColumns: string[]): string {
  return `
    CREATE OR REPLACE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'wager_transactions_append_only: % is not allowed on wager_transactions', TG_OP
          USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_append_only';
      END IF;
      IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
        RAISE EXCEPTION 'wager_transactions_terminal_immutable: transaction % is % and cannot change', OLD.id, OLD.status
          USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_terminal_immutable',
                DETAIL = format('transaction_id=%s status=%s attempted_status=%s', OLD.id, OLD.status, NEW.status);
      END IF;
      IF (${row("NEW", immutableColumns)}) IS DISTINCT FROM (${row("OLD", immutableColumns)}) THEN
        RAISE EXCEPTION 'wager_transactions_payload_immutable: transaction % cannot change its payload', OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_payload_immutable',
                DETAIL = format('transaction_id=%s', OLD.id);
      END IF;
      IF (OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING') OR NEW.reference_attempts < OLD.reference_attempts THEN
        RAISE EXCEPTION 'wager_transactions_transition_valid: transaction % cannot go from % to % or reduce reference_attempts from % to %',
            OLD.id, OLD.status, NEW.status, OLD.reference_attempts, NEW.reference_attempts
          USING ERRCODE = 'check_violation', CONSTRAINT = 'wager_transactions_transition_valid',
                DETAIL = format('transaction_id=%s old_status=%s new_status=%s old_reference_attempts=%s new_reference_attempts=%s',
                                OLD.id, OLD.status, NEW.status, OLD.reference_attempts, NEW.reference_attempts);
      END IF;
      RETURN NEW;
    END
    $$
  `;
}

function outboxMessagesGuard(immutableColumns: string[]): string {
  return `
    CREATE OR REPLACE FUNCTION outbox_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'outbox_messages_retention: TRUNCATE is not allowed because it could drop unpublished events'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_messages_retention';
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF OLD.published_at IS NULL THEN
          RAISE EXCEPTION 'outbox_messages_retention: message % (%) is not published yet and cannot be deleted', OLD.id, OLD.event_type
            USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_messages_retention',
                  DETAIL = format('message_id=%s event_type=%s aggregate_id=%s', OLD.id, OLD.event_type, OLD.aggregate_id);
        END IF;
        RETURN OLD;
      END IF;
      IF (${row("NEW", immutableColumns)}) IS DISTINCT FROM (${row("OLD", immutableColumns)}) THEN
        RAISE EXCEPTION 'outbox_messages_content_immutable: message % cannot change its content', OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_messages_content_immutable',
                DETAIL = format('message_id=%s event_type=%s', OLD.id, OLD.event_type);
      END IF;
      IF OLD.published_at IS NOT NULL THEN
        RAISE EXCEPTION 'outbox_messages_published_once: message % was published at % and cannot change', OLD.id, OLD.published_at
          USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_messages_published_once',
                DETAIL = format('message_id=%s published_at=%s', OLD.id, OLD.published_at);
      END IF;
      RETURN NEW;
    END
    $$
  `;
}

export class Migration20261002000007_outbox_ordering_and_reference_dependents extends Migration {
  override up(): void {
    this.addSql(`ALTER TABLE outbox_messages ADD COLUMN ordering_key text`);
    this.addSql(`ALTER TABLE outbox_messages ADD COLUMN position bigint GENERATED ALWAYS AS IDENTITY`);
    this.addSql(`ALTER TABLE outbox_messages DISABLE TRIGGER outbox_messages_guard`);
    this.addSql(`UPDATE outbox_messages SET ordering_key = payload->'data'->>'walletId'`);
    this.addSql(`ALTER TABLE outbox_messages ENABLE TRIGGER outbox_messages_guard`);
    this.addSql(`ALTER TABLE outbox_messages ALTER COLUMN ordering_key SET NOT NULL`);
    this.addSql(`
      ALTER TABLE outbox_messages ADD CONSTRAINT outbox_messages_ordering_key_bounds
        CHECK (length(ordering_key) BETWEEN 1 AND 128)
    `);
    this.addSql(`
      CREATE INDEX outbox_messages_pending_by_ordering_key ON outbox_messages (ordering_key, position)
        WHERE published_at IS NULL
    `);
    this.addSql(outboxMessagesGuard([...outboxContentColumns, "ordering_key", "position"]));

    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN correlation_id text`);
    this.addSql(`ALTER TABLE wager_transactions DISABLE TRIGGER wager_transactions_guard`);
    this.addSql(`UPDATE wager_transactions SET correlation_id = id::text`);
    this.addSql(`ALTER TABLE wager_transactions ENABLE TRIGGER wager_transactions_guard`);
    this.addSql(`ALTER TABLE wager_transactions ALTER COLUMN correlation_id SET NOT NULL`);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_correlation_id_bounds
        CHECK (length(correlation_id) BETWEEN 1 AND 128)
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_waiting_for_reference
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE'
    `);
    this.addSql(wagerTransactionsGuard([...wagerPayloadColumns, "correlation_id"]));
  }

  override down(): void {
    this.addSql(wagerTransactionsGuard(wagerPayloadColumns));
    this.addSql(`DROP INDEX wager_transactions_waiting_for_reference`);
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN correlation_id`);
    this.addSql(outboxMessagesGuard(outboxContentColumns));
    this.addSql(`DROP INDEX outbox_messages_pending_by_ordering_key`);
    this.addSql(`ALTER TABLE outbox_messages DROP COLUMN position`);
    this.addSql(`ALTER TABLE outbox_messages DROP COLUMN ordering_key`);
  }
}
