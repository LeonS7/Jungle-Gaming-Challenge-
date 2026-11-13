/**
 * Esta página cria e reverte o schema financeiro com constraints e gatilhos.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration20261113000000_CreateWageringSchema extends Migration {
  override up(): void {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" text not null,
        "currency" char(3) not null,
        "balance" numeric(30, 2) not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_player_currency_uq" unique ("player_id", "currency"),
        constraint "wallets_id_currency_uq" unique ("id", "currency"),
        constraint "wallets_id_player_currency_uq" unique ("id", "player_id", "currency"),
        constraint "wallets_id_nonempty_ck" check (length(btrim("player_id")) > 0),
        constraint "wallets_currency_ck" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_balance_nonnegative_ck" check ("balance" >= 0),
        constraint "wallets_version_positive_ck" check ("version" > 0)
      );
    `);

    this.addSql(`
      create function "protect_wallet_identity_and_version"() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'INSERT' then
          if new."version" <> 1 then
            raise exception using errcode = '23514',
              message = 'A versão inicial da carteira deve ser 1';
          end if;
          return new;
        end if;

        if new."id" is distinct from old."id"
          or new."player_id" is distinct from old."player_id"
          or new."currency" is distinct from old."currency"
          or new."created_at" is distinct from old."created_at" then
          raise exception using errcode = '23514',
            message = 'A identidade da carteira não pode ser alterada';
        end if;

        if new."balance" is distinct from old."balance" then
          if new."version" <> old."version" + 1 then
            raise exception using errcode = '23514',
              message = 'A versão deve avançar uma unidade quando o saldo mudar';
          end if;
        elsif new."version" <> old."version" then
          raise exception using errcode = '23514',
            message = 'A versão só pode avançar quando o saldo mudar';
        end if;

        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger "wallets_identity_version_guard"
      before insert or update on "wallets"
      for each row execute function "protect_wallet_identity_and_version"();
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" text not null,
        "external_transaction_id" text not null,
        "idempotency_key" text not null,
        "payload_hash" text not null,
        "wallet_id" uuid not null,
        "player_id" text not null,
        "currency" char(3) not null,
        "round_id" text not null,
        "game_id" text not null,
        "kind" varchar(16) not null,
        "amount" numeric(30, 2) not null,
        "reference_external_transaction_id" text null,
        "reference_transaction_id" uuid null,
        "status" varchar(24) not null,
        "failure_code" text null,
        "created_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_idempotency_key_uq" unique ("idempotency_key"),
        constraint "wager_transactions_provider_external_uq"
          unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_id_wallet_uq" unique ("id", "wallet_id"),
        constraint "wager_transactions_reference_scope_uq"
          unique ("id", "provider_id", "external_transaction_id", "player_id", "wallet_id", "round_id", "currency"),
        constraint "wager_transactions_wallet_owner_fk"
          foreign key ("wallet_id", "player_id", "currency")
          references "wallets" ("id", "player_id", "currency") on delete restrict,
        constraint "wager_transactions_reference_scope_fk"
          foreign key (
            "reference_transaction_id", "provider_id", "reference_external_transaction_id",
            "player_id", "wallet_id", "round_id", "currency"
          )
          references "wager_transactions" (
            "id", "provider_id", "external_transaction_id", "player_id", "wallet_id", "round_id", "currency"
          ) on delete restrict,
        constraint "wager_transactions_identifiers_nonempty_ck" check (
          length(btrim("provider_id")) > 0
          and length(btrim("external_transaction_id")) > 0
          and length(btrim("idempotency_key")) > 0
          and length(btrim("payload_hash")) > 0
          and length(btrim("player_id")) > 0
          and length(btrim("round_id")) > 0
          and length(btrim("game_id")) > 0
        ),
        constraint "wager_transactions_currency_ck" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_kind_ck" check (
          "kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        constraint "wager_transactions_amount_positive_ck" check ("amount" > 0),
        constraint "wager_transactions_reference_required_ck" check (
          "kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null
        ),
        constraint "wager_transactions_reference_pair_ck" check (
          "reference_transaction_id" is null or "reference_external_transaction_id" is not null
        ),
        constraint "wager_transactions_status_ck" check (
          "status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        constraint "wager_transactions_failure_code_ck" check (
          ("status" in ('REJECTED', 'FAILED') and "failure_code" is not null
            and "failure_code" ~ '^[A-Z][A-Z0-9_]*$')
          or ("status" not in ('REJECTED', 'FAILED') and "failure_code" is null)
        ),
        constraint "wager_transactions_processed_at_ck" check (
          ("status" = 'PROCESSED' and "processed_at" is not null)
          or ("status" <> 'PROCESSED' and "processed_at" is null)
        ),
        constraint "wager_transactions_processed_reference_ck" check (
          "status" <> 'PROCESSED' or "kind" not in ('REFUND', 'ROLLBACK')
          or "reference_transaction_id" is not null
        )
      );
    `);

    this.addSql(`
      create unique index "wager_transactions_unique_reversal_uq"
      on "wager_transactions" ("reference_transaction_id", "kind")
      where "kind" in ('REFUND', 'ROLLBACK')
        and "status" = 'PROCESSED'
        and "reference_transaction_id" is not null;
    `);
    this.addSql(`
      create index "wager_transactions_wallet_created_idx"
      on "wager_transactions" ("wallet_id", "created_at", "id");
    `);

    this.addSql(`
      create function "protect_wager_transaction_transitions"() returns trigger
      language plpgsql as $$
      begin
        if row(
          new."id", new."provider_id", new."external_transaction_id", new."idempotency_key",
          new."payload_hash", new."wallet_id", new."player_id", new."currency", new."round_id",
          new."game_id", new."kind", new."amount", new."reference_external_transaction_id", new."created_at"
        ) is distinct from row(
          old."id", old."provider_id", old."external_transaction_id", old."idempotency_key",
          old."payload_hash", old."wallet_id", old."player_id", old."currency", old."round_id",
          old."game_id", old."kind", old."amount", old."reference_external_transaction_id", old."created_at"
        ) then
          raise exception using errcode = '23514',
            message = 'Os dados originais da transação não podem ser alterados';
        end if;

        if old."status" in ('PROCESSED', 'REJECTED', 'FAILED')
          and row(
            new."status", new."reference_transaction_id", new."failure_code", new."processed_at"
          ) is distinct from row(
            old."status", old."reference_transaction_id", old."failure_code", old."processed_at"
          ) then
          raise exception using errcode = '23514',
            message = 'Uma transação terminal não pode ser alterada';
        end if;

        if new."status" is distinct from old."status" and not (
          (old."status" = 'PENDING' and new."status" in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
          or (old."status" = 'PENDING_REFERENCE' and new."status" in ('PROCESSED', 'REJECTED', 'FAILED'))
        ) then
          raise exception using errcode = '23514',
            message = 'Transição de estado de transação inválida';
        end if;

        if old."reference_transaction_id" is not null
          and new."reference_transaction_id" is distinct from old."reference_transaction_id" then
          raise exception using errcode = '23514',
            message = 'A referência interna resolvida não pode ser substituída';
        end if;

        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger "wager_transactions_transition_guard"
      before update on "wager_transactions"
      for each row execute function "protect_wager_transaction_transitions"();
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(6) not null,
        "amount" numeric(30, 2) not null,
        "currency" char(3) not null,
        "balance_before" numeric(30, 2) not null,
        "balance_after" numeric(30, 2) not null,
        "created_at" timestamptz not null default now(),
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_wallet_transaction_uq" unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_entries_wallet_currency_fk"
          foreign key ("wallet_id", "currency") references "wallets" ("id", "currency") on delete restrict,
        constraint "wallet_ledger_entries_transaction_wallet_fk"
          foreign key ("transaction_id", "wallet_id")
          references "wager_transactions" ("id", "wallet_id") on delete restrict,
        constraint "wallet_ledger_entries_direction_ck" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_amount_positive_ck" check ("amount" > 0),
        constraint "wallet_ledger_entries_balances_nonnegative_ck"
          check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_entries_arithmetic_ck" check (
          ("direction" = 'DEBIT' and "balance_before" - "amount" = "balance_after")
          or ("direction" = 'CREDIT' and "balance_before" + "amount" = "balance_after")
        )
      );
    `);
    this.addSql(`
      create index "wallet_ledger_entries_wallet_created_idx"
      on "wallet_ledger_entries" ("wallet_id", "created_at", "id");
    `);

    this.addSql(`
      create function "protect_wallet_ledger_entries"() returns trigger
      language plpgsql as $$
      begin
        raise exception using errcode = '55000',
          message = 'Lançamentos do ledger são imutáveis';
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create trigger "wallet_ledger_entries_no_update_delete"
      before update or delete on "wallet_ledger_entries"
      for each row execute function "protect_wallet_ledger_entries"();
    `);
    this.addSql(`
      create trigger "wallet_ledger_entries_no_truncate"
      before truncate on "wallet_ledger_entries"
      for each statement execute function "protect_wallet_ledger_entries"();
    `);

    this.addSql(`
      create function "guard_wallet_ledger_insert"() returns trigger
      language plpgsql as $$
      declare
        transaction_kind varchar(16);
        transaction_status varchar(24);
        selected_rows integer;
      begin
        execute format(
          'select "kind", "status" from %I."wager_transactions" where "id" = $1 for key share',
          tg_table_schema
        ) into transaction_kind, transaction_status using new."transaction_id";
        get diagnostics selected_rows = row_count;

        if selected_rows = 0 then
          raise exception using errcode = '23503',
            message = 'A transação do lançamento não existe';
        end if;
        if transaction_kind = 'LOSS' then
          raise exception using errcode = '23514',
            message = 'LOSS não pode gerar lançamento no ledger';
        end if;
        if transaction_status in ('REJECTED', 'FAILED') then
          raise exception using errcode = '23514',
            message = 'Transação rejeitada ou falha não pode gerar lançamento';
        end if;

        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger "wallet_ledger_entries_transaction_guard"
      before insert on "wallet_ledger_entries"
      for each row execute function "guard_wallet_ledger_insert"();
    `);
  }

  override down(): void {
    this.addSql('drop table if exists "wallet_ledger_entries";');
    this.addSql('drop table if exists "wager_transactions";');
    this.addSql('drop table if exists "wallets";');
    this.addSql('drop function if exists "guard_wallet_ledger_insert"();');
    this.addSql('drop function if exists "protect_wallet_ledger_entries"();');
    this.addSql('drop function if exists "protect_wager_transaction_transitions"();');
    this.addSql('drop function if exists "protect_wallet_identity_and_version"();');
  }
}
