import { Migration } from "@mikro-orm/migrations";

export class Migration20261002000004_create_ledger_coherence_checks extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION wallets_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        latest wallet_ledger_entries%ROWTYPE;
      BEGIN
        IF NEW.version = 1 AND NEW.balance = 0 THEN
          RETURN NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries
           WHERE wallet_id = NEW.id AND wallet_version = NEW.version AND balance_after = NEW.balance
        ) THEN
          SELECT * INTO latest FROM wallet_ledger_entries
           WHERE wallet_id = NEW.id ORDER BY wallet_version DESC LIMIT 1;
          RAISE EXCEPTION 'wallets_balance_matches_ledger: wallet % at version % has balance % but no ledger entry with wallet_version=% and balance_after=%',
              NEW.id, NEW.version, NEW.balance, NEW.version, NEW.balance
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_balance_matches_ledger',
                  DETAIL = format('wallet_id=%s version=%s balance=%s latest_entry_version=%s latest_entry_balance_after=%s',
                                  NEW.id, NEW.version, NEW.balance,
                                  coalesce(latest.wallet_version::text, 'none'), coalesce(latest.balance_after::text, 'none'));
        END IF;
        RETURN NULL;
      END
      $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_balance_matches_ledger AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_balance_matches_ledger()
    `);
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_chained() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous wallet_ledger_entries%ROWTYPE;
        current_wallet_version bigint;
      BEGIN
        SELECT * INTO previous FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
        IF FOUND THEN
          IF previous.balance_after <> NEW.balance_before THEN
            RAISE EXCEPTION 'wallet_ledger_entries_chained: entry % of wallet % at wallet_version % starts at % but the previous entry ends at %',
                NEW.id, NEW.wallet_id, NEW.wallet_version, NEW.balance_before, previous.balance_after
              USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_chained',
                    DETAIL = format('wallet_id=%s wallet_version=%s entry_id=%s balance_before=%s previous_entry_id=%s previous_balance_after=%s',
                                    NEW.wallet_id, NEW.wallet_version, NEW.id, NEW.balance_before, previous.id, previous.balance_after);
          END IF;
        ELSIF NEW.wallet_version > 2 OR NEW.balance_before <> 0 THEN
          RAISE EXCEPTION 'wallet_ledger_entries_chained: entry % of wallet % at wallet_version % has no previous entry, so it must be the first movement (wallet_version 1 or 2) starting at 0.00, got balance_before %',
              NEW.id, NEW.wallet_id, NEW.wallet_version, NEW.balance_before
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_chained',
                  DETAIL = format('wallet_id=%s wallet_version=%s entry_id=%s balance_before=%s previous_entry=none',
                                  NEW.wallet_id, NEW.wallet_version, NEW.id, NEW.balance_before);
        END IF;
        SELECT version INTO current_wallet_version FROM wallets WHERE id = NEW.wallet_id;
        IF current_wallet_version < NEW.wallet_version THEN
          RAISE EXCEPTION 'wallet_ledger_entries_chained: entry % is at wallet_version % but wallet % is still at version %',
              NEW.id, NEW.wallet_version, NEW.wallet_id, current_wallet_version
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_chained',
                  DETAIL = format('wallet_id=%s wallet_version=%s entry_id=%s current_wallet_version=%s',
                                  NEW.wallet_id, NEW.wallet_version, NEW.id, current_wallet_version);
        END IF;
        RETURN NULL;
      END
      $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_chained AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_chained()
    `);
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_match_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        tx wager_transactions%ROWTYPE;
        reference_entry wallet_ledger_entries%ROWTYPE;
        reference_kind text;
        description text;
        expected_direction text;
      BEGIN
        SELECT * INTO tx FROM wager_transactions WHERE id = NEW.transaction_id;
        description := tx.kind;
        IF tx.status <> 'PROCESSED' THEN
          RAISE EXCEPTION 'wallet_ledger_entries_match_transaction: entry % for transaction % (%) requires a PROCESSED transaction, got %',
              NEW.id, tx.id, description, tx.status
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_match_transaction',
                  DETAIL = format('wallet_id=%s wallet_version=%s transaction_id=%s kind=%s expected_status=PROCESSED received_status=%s',
                                  NEW.wallet_id, NEW.wallet_version, tx.id, tx.kind, tx.status);
        END IF;
        IF tx.kind = 'LOSS' THEN
          RAISE EXCEPTION 'wallet_ledger_entries_match_transaction: entry % for transaction % (LOSS) is not allowed, LOSS never moves balance',
              NEW.id, tx.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_match_transaction',
                  DETAIL = format('wallet_id=%s wallet_version=%s transaction_id=%s kind=LOSS',
                                  NEW.wallet_id, NEW.wallet_version, tx.id);
        END IF;
        IF tx.amount <> NEW.amount OR tx.currency <> NEW.currency THEN
          RAISE EXCEPTION 'wallet_ledger_entries_match_transaction: entry % for transaction % (%) moves % %, expected % %',
              NEW.id, tx.id, description, NEW.amount, NEW.currency, tx.amount, tx.currency
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_match_transaction',
                  DETAIL = format('wallet_id=%s wallet_version=%s transaction_id=%s kind=%s expected_amount=%s expected_currency=%s received_amount=%s received_currency=%s',
                                  NEW.wallet_id, NEW.wallet_version, tx.id, tx.kind, tx.amount, tx.currency, NEW.amount, NEW.currency);
        END IF;
        IF tx.kind = 'ROLLBACK' THEN
          SELECT kind INTO reference_kind FROM wager_transactions WHERE id = tx.reference_transaction_id;
          description := format('ROLLBACK of %s %s', reference_kind, tx.reference_transaction_id);
          SELECT * INTO reference_entry FROM wallet_ledger_entries WHERE transaction_id = tx.reference_transaction_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'wallet_ledger_entries_match_transaction: entry % for transaction % (%) has no reference ledger entry to invert',
                NEW.id, tx.id, description
              USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_match_transaction',
                    DETAIL = format('wallet_id=%s wallet_version=%s transaction_id=%s kind=ROLLBACK reference_transaction_id=%s reference_direction=none',
                                    NEW.wallet_id, NEW.wallet_version, tx.id, tx.reference_transaction_id);
          END IF;
          expected_direction := CASE reference_entry.direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END;
        ELSE
          expected_direction := CASE tx.kind WHEN 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
        END IF;
        IF NEW.direction <> expected_direction THEN
          RAISE EXCEPTION 'wallet_ledger_entries_match_transaction: entry % for transaction % (%) has direction %, expected %',
              NEW.id, tx.id, description, NEW.direction, expected_direction
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_match_transaction',
                  DETAIL = format('wallet_id=%s wallet_version=%s transaction_id=%s kind=%s reference_transaction_id=%s reference_direction=%s expected_direction=%s received_direction=%s',
                                  NEW.wallet_id, NEW.wallet_version, tx.id, tx.kind,
                                  coalesce(tx.reference_transaction_id::text, 'none'), coalesce(reference_entry.direction, 'none'),
                                  expected_direction, NEW.direction);
        END IF;
        RETURN NULL;
      END
      $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_match_transaction AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_match_transaction()
    `);
  }

  override down(): void {
    this.addSql(`DROP TRIGGER wallet_ledger_entries_match_transaction ON wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION wallet_ledger_entries_match_transaction()`);
    this.addSql(`DROP TRIGGER wallet_ledger_entries_chained ON wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION wallet_ledger_entries_chained()`);
    this.addSql(`DROP TRIGGER wallets_balance_matches_ledger ON wallets`);
    this.addSql(`DROP FUNCTION wallets_balance_matches_ledger()`);
  }
}
