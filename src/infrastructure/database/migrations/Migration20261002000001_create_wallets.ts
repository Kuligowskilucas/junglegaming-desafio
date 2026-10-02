import { Migration } from "@mikro-orm/migrations";

export class Migration20261002000001_create_wallets extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id         uuid          PRIMARY KEY,
        player_id  uuid          NOT NULL,
        currency   char(3)       NOT NULL,
        balance    numeric(19,2) NOT NULL,
        version    bigint        NOT NULL,
        created_at timestamptz   NOT NULL,
        updated_at timestamptz   NOT NULL,
        CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_key UNIQUE (id, currency),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_timestamps_ordered CHECK (updated_at >= created_at)
      )
    `);
    this.addSql(`
      CREATE FUNCTION wallets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallets_identity_immutable: wallet % cannot change id, player_id, currency or created_at', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_identity_immutable',
                  DETAIL = format('wallet_id=%s', OLD.id);
        END IF;
        IF NEW.balance IS DISTINCT FROM OLD.balance AND NEW.version IS DISTINCT FROM OLD.version + 1 THEN
          RAISE EXCEPTION 'wallets_version_follows_balance: wallet % changed balance from % to % so version must go from % to %, got %',
              OLD.id, OLD.balance, NEW.balance, OLD.version, OLD.version + 1, NEW.version
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_version_follows_balance',
                  DETAIL = format('wallet_id=%s old_balance=%s new_balance=%s old_version=%s expected_version=%s received_version=%s',
                                  OLD.id, OLD.balance, NEW.balance, OLD.version, OLD.version + 1, NEW.version);
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version IS DISTINCT FROM OLD.version THEN
          RAISE EXCEPTION 'wallets_version_follows_balance: wallet % kept balance % so version must stay %, got %',
              OLD.id, OLD.balance, OLD.version, NEW.version
            USING ERRCODE = 'check_violation', CONSTRAINT = 'wallets_version_follows_balance',
                  DETAIL = format('wallet_id=%s balance=%s expected_version=%s received_version=%s',
                                  OLD.id, OLD.balance, OLD.version, NEW.version);
        END IF;
        RETURN NEW;
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wallets_guard_update BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard_update()
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE wallets`);
    this.addSql(`DROP FUNCTION wallets_guard_update()`);
  }
}
