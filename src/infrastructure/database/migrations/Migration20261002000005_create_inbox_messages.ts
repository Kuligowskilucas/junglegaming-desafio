import { Migration } from "@mikro-orm/migrations";

export class Migration20261002000005_create_inbox_messages extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  char(64)    NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_messages_text_bounds CHECK (
          length(consumer_name) BETWEEN 1 AND 128 AND length(message_id) BETWEEN 1 AND 256
        ),
        CONSTRAINT inbox_messages_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT inbox_messages_processed_after_received CHECK (processed_at IS NULL OR processed_at >= received_at)
      )
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE inbox_messages`);
  }
}
