/**
 * Esta página cria uma outbox reversível com payload imutável e estado de entrega.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration20261113030000_AddTransactionalOutbox extends Migration {
  override up(): void {
    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "transaction_id" uuid not null,
        "sequence_number" integer not null,
        "aggregate_id" text not null,
        "event_type" text not null,
        "correlation_id" text not null,
        "version" integer not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "created_at" timestamptz not null default now(),
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz not null default now(),
        "lock_token" uuid null,
        "locked_until" timestamptz null,
        "published_at" timestamptz null,
        constraint "outbox_messages_pkey" primary key ("id"),
        constraint "outbox_messages_transaction_fk"
          foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict,
        constraint "outbox_messages_transaction_type_uq"
          unique ("transaction_id", "event_type"),
        constraint "outbox_messages_transaction_sequence_uq"
          unique ("transaction_id", "sequence_number"),
        constraint "outbox_messages_identity_ck" check (
          length(btrim("aggregate_id")) > 0
          and length(btrim("event_type")) > 0
          and length(btrim("correlation_id")) > 0
          and "sequence_number" > 0
          and "version" > 0
          and "attempts" >= 0
        ),
        constraint "outbox_messages_payload_object_ck"
          check (jsonb_typeof("payload") = 'object'),
        constraint "outbox_messages_payload_envelope_ck" check (
          ("payload" ->> 'eventId') is not distinct from "id"::text
          and ("payload" ->> 'eventType') is not distinct from "event_type"
          and ("payload" ->> 'aggregateId') is not distinct from "aggregate_id"
          and ("payload" ->> 'correlationId') is not distinct from "correlation_id"
          and ("payload" ->> 'version') is not distinct from "version"::text
          and ("payload" #>> '{data,transactionId}') is not distinct from "transaction_id"::text
          and jsonb_typeof("payload" #> '{data,money,amount}') = 'string'
          and jsonb_typeof("payload" #> '{data,money,currency}') = 'string'
        ),
        constraint "outbox_messages_lock_pair_ck"
          check (("lock_token" is null) = ("locked_until" is null)),
        constraint "outbox_messages_published_unlocked_ck"
          check ("published_at" is null or ("lock_token" is null and "locked_until" is null))
      );
    `);

    this.addSql(`
      create index "outbox_messages_pending_idx"
      on "outbox_messages" ("next_attempt_at", "created_at", "id")
      where "published_at" is null;
    `);

    this.addSql(`
      create function "protect_outbox_message_contents"() returns trigger
      language plpgsql as $$
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception using errcode = '55000',
            message = 'Mensagens da outbox não podem ser removidas';
        end if;

        if row(
          new."id", new."transaction_id", new."sequence_number", new."aggregate_id", new."event_type",
          new."correlation_id", new."version", new."payload", new."occurred_at", new."created_at"
        ) is distinct from row(
          old."id", old."transaction_id", old."sequence_number", old."aggregate_id", old."event_type",
          old."correlation_id", old."version", old."payload", old."occurred_at", old."created_at"
        ) then
          raise exception using errcode = '55000',
            message = 'O conteúdo de uma mensagem da outbox é imutável';
        end if;

        if old."published_at" is not null
          and new."published_at" is distinct from old."published_at" then
          raise exception using errcode = '55000',
            message = 'Uma mensagem publicada não pode voltar à outbox pendente';
        end if;

        if new."attempts" < old."attempts" then
          raise exception using errcode = '23514',
            message = 'O contador de tentativas da outbox não pode diminuir';
        end if;

        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger "outbox_messages_content_guard"
      before update or delete on "outbox_messages"
      for each row execute function "protect_outbox_message_contents"();
    `);
    this.addSql(`
      create trigger "outbox_messages_no_truncate"
      before truncate on "outbox_messages"
      for each statement execute function "protect_outbox_message_contents"();
    `);
  }

  override down(): void {
    this.addSql('drop table if exists "outbox_messages";');
    this.addSql('drop function if exists "protect_outbox_message_contents"();');
  }
}
