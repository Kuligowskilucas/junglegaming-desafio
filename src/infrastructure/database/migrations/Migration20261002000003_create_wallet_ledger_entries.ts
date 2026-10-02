import { Migration } from "@mikro-orm/migrations";

export class Migration20261002000003_create_wallet_ledger_entries extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid          PRIMARY KEY,
        wallet_id      uuid          NOT NULL,
        wallet_version bigint        NOT NULL,
        transaction_id uuid          NOT NULL,
        direction      text          NOT NULL,
        amount         numeric(19,2) NOT NULL,
        currency       char(3)       NOT NULL,
        balance_before numeric(19,2) NOT NULL,
        balance_after  numeric(19,2) NOT NULL,
        created_at     timestamptz   NOT NULL,
        CONSTRAINT wallet_ledger_entries_wallet_currency_fkey
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wallet_ledger_entries_transaction_wallet_fkey
          FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
        CONSTRAINT wallet_ledger_entries_one_per_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT wallet_ledger_entries_wallet_version_key UNIQUE (wallet_id, wallet_version),
        CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_wallet_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT wallet_ledger_entries_arithmetic CHECK (
          balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END
        )
      )
    `);
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_LEVEL = 'ROW' THEN
          RAISE EXCEPTION 'wallet_ledger_entries_append_only: % of entry % is not allowed, the ledger is append-only', TG_OP, OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_append_only',
                  DETAIL = format('entry_id=%s wallet_id=%s wallet_version=%s', OLD.id, OLD.wallet_id, OLD.wallet_version);
        END IF;
        RAISE EXCEPTION 'wallet_ledger_entries_append_only: % is not allowed, the ledger is append-only', TG_OP
          USING ERRCODE = 'check_violation', CONSTRAINT = 'wallet_ledger_entries_append_only';
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_append_only()
    `);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_append_only()
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION wallet_ledger_entries_append_only()`);
  }
}
