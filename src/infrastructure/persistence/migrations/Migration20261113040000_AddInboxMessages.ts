/**
 * Esta página cria e reverte o registro durável de mensagens consumidas.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration20261113040000_AddInboxMessages extends Migration {
  override up(): void {
    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" text not null,
        "message_id" text not null,
        "payload_hash" char(64) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "inbox_messages_pkey"
          primary key ("consumer_name", "message_id"),
        constraint "inbox_messages_identity_ck" check (
          length(btrim("consumer_name")) > 0
          and length(btrim("message_id")) > 0
        ),
        constraint "inbox_messages_payload_hash_ck"
          check ("payload_hash" ~ '^[0-9a-f]{64}$'),
        constraint "inbox_messages_processed_at_ck" check (
          "processed_at" is null or "processed_at" >= "received_at"
        )
      );
    `);
    this.addSql(`
      create function "protect_inbox_message_identity"() returns trigger
      language plpgsql as $$
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception using errcode = '55000',
            message = 'Mensagens da inbox não podem ser removidas';
        end if;

        if row(
          new."consumer_name", new."message_id", new."payload_hash", new."received_at"
        ) is distinct from row(
          old."consumer_name", old."message_id", old."payload_hash", old."received_at"
        ) then
          raise exception using errcode = '55000',
            message = 'A identidade de uma mensagem da inbox é imutável';
        end if;

        if old."processed_at" is not null
          and new."processed_at" is distinct from old."processed_at" then
          raise exception using errcode = '55000',
            message = 'Uma mensagem concluída da inbox não pode ser reaberta';
        end if;

        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger "inbox_messages_identity_guard"
      before update or delete on "inbox_messages"
      for each row execute function "protect_inbox_message_identity"();
    `);
    this.addSql(`
      create trigger "inbox_messages_no_truncate"
      before truncate on "inbox_messages"
      for each statement execute function "protect_inbox_message_identity"();
    `);
  }

  override down(): void {
    this.addSql('drop table if exists "inbox_messages";');
    this.addSql('drop function if exists "protect_inbox_message_identity"();');
  }
}
