import { Migration } from "@mikro-orm/migrations";

export class Migration20261002000006_create_outbox_messages extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    uuid        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        CONSTRAINT outbox_messages_event_type_format CHECK (event_type ~ '^[A-Z][A-Za-z0-9]{0,127}$'),
        CONSTRAINT outbox_messages_payload_envelope CHECK (
          jsonb_typeof(payload) = 'object'
          AND payload->>'eventId' = id::text
          AND payload->>'eventType' = event_type
          AND payload->>'aggregateId' = aggregate_id::text
        ),
        CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_messages_published_has_no_schedule CHECK (published_at IS NULL OR next_attempt_at IS NULL)
      )
    `);
    this.addSql(`
      CREATE INDEX outbox_messages_pending_due ON outbox_messages ((coalesce(next_attempt_at, occurred_at)), id)
        WHERE published_at IS NULL
    `);
    this.addSql(`
      CREATE FUNCTION outbox_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
        IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
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
    `);
    this.addSql(`
      CREATE TRIGGER outbox_messages_guard BEFORE UPDATE OR DELETE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_messages_guard()
    `);
    this.addSql(`
      CREATE TRIGGER outbox_messages_guard_truncate BEFORE TRUNCATE ON outbox_messages
        FOR EACH STATEMENT EXECUTE FUNCTION outbox_messages_guard()
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE outbox_messages`);
    this.addSql(`DROP FUNCTION outbox_messages_guard()`);
  }
}
