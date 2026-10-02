import { Migration } from "@mikro-orm/migrations";

export class Migration20261002000002_create_wager_transactions extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL,
        external_transaction_id           text          NOT NULL,
        idempotency_key                   text          NOT NULL,
        payload_hash                      char(64)      NOT NULL,
        wallet_id                         uuid          NOT NULL REFERENCES wallets (id),
        player_id                         uuid          NOT NULL,
        round_id                          text          NOT NULL,
        game_id                           text          NOT NULL,
        kind                              text          NOT NULL,
        amount                            numeric(19,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text,
        status                            text          NOT NULL,
        reference_transaction_id          uuid          REFERENCES wager_transactions (id),
        failure_code                      text,
        observed_balance                  numeric(19,2),
        reference_attempts                integer       NOT NULL,
        next_reference_attempt_at         timestamptz,
        created_at                        timestamptz   NOT NULL,
        updated_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT wager_transactions_idempotency_key UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_transactions_external_id_key UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_id_wallet_key UNIQUE (id, wallet_id),
        CONSTRAINT wager_transactions_text_bounds CHECK (
          length(provider_id) BETWEEN 1 AND 128
          AND length(external_transaction_id) BETWEEN 1 AND 128
          AND length(idempotency_key) BETWEEN 1 AND 255
          AND length(round_id) BETWEEN 1 AND 128
          AND length(game_id) BETWEEN 1 AND 128
          AND (reference_external_transaction_id IS NULL OR length(reference_external_transaction_id) BETWEEN 1 AND 128)
        ),
        CONSTRAINT wager_transactions_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_transactions_kind_valid CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid CHECK (
          status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        CONSTRAINT wager_transactions_failure_code_valid CHECK (failure_code IN (
          'INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'CURRENCY_MISMATCH', 'WALLET_PLAYER_MISMATCH',
          'REFERENCE_NOT_FOUND', 'REFERENCE_INVALID_KIND', 'REFERENCE_MISMATCH', 'REFERENCE_AMOUNT_MISMATCH',
          'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_REVERSED', 'PROCESSING_RETRIES_EXHAUSTED'
        )),
        CONSTRAINT wager_transactions_amount_by_kind CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
        CONSTRAINT wager_transactions_reference_by_kind CHECK (
          CASE
            WHEN kind IN ('REFUND', 'ROLLBACK') THEN reference_external_transaction_id IS NOT NULL
            WHEN kind IN ('BET', 'OPENING') THEN reference_external_transaction_id IS NULL
            ELSE true
          END
        ),
        CONSTRAINT wager_transactions_no_self_reference CHECK (
          reference_external_transaction_id IS DISTINCT FROM external_transaction_id
        ),
        CONSTRAINT wager_transactions_opening_is_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT wager_transactions_resolved_reference CHECK (
          (reference_transaction_id IS NOT NULL) = (status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL)
        ),
        CONSTRAINT wager_transactions_failure_code_by_status CHECK (
          CASE status
            WHEN 'REJECTED' THEN failure_code IS NOT NULL AND failure_code <> 'PROCESSING_RETRIES_EXHAUSTED'
            WHEN 'FAILED' THEN failure_code IS NOT NULL AND failure_code = 'PROCESSING_RETRIES_EXHAUSTED'
            ELSE failure_code IS NULL
          END
        ),
        CONSTRAINT wager_transactions_processed_at_by_status CHECK ((processed_at IS NOT NULL) = (status = 'PROCESSED')),
        CONSTRAINT wager_transactions_observed_balance_by_status CHECK (
          (observed_balance IS NOT NULL) = (status IN ('PROCESSED', 'REJECTED'))
          AND (observed_balance IS NULL OR observed_balance >= 0)
        ),
        CONSTRAINT wager_transactions_reference_schedule_by_status CHECK (
          (next_reference_attempt_at IS NOT NULL) = (status = 'PENDING_REFERENCE')
        ),
        CONSTRAINT wager_transactions_reference_attempts_non_negative CHECK (reference_attempts >= 0),
        CONSTRAINT wager_transactions_timestamps_ordered CHECK (updated_at >= created_at)
      )
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_one_reversal_per_reference ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_due ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
    this.addSql(`CREATE INDEX wager_transactions_wallet_id ON wager_transactions (wallet_id)`);
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id,
            NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id,
            OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
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
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()
    `);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_truncate BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION wager_transactions_guard()
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE wager_transactions`);
    this.addSql(`DROP FUNCTION wager_transactions_guard()`);
  }
}
