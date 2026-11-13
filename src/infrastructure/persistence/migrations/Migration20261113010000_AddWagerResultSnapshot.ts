/**
 * Esta página persiste o saldo observado para responder replays idempotentes.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration20261113010000_AddWagerResultSnapshot extends Migration {
  override up(): void {
    this.addSql(`
      alter table "wager_transactions"
        add column "result_balance" numeric(30, 2) null,
        add column "result_currency" char(3) null,
        add constraint "wager_transactions_result_snapshot_ck" check (
          ("result_balance" is null and "result_currency" is null)
          or (
            "status" in ('PROCESSED', 'REJECTED')
            and "result_balance" >= 0
            and "result_currency" = "currency"
          )
        );
    `);

    this.addSql(`
      create function "protect_wager_result_snapshot"() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'INSERT' then
          if new."status" <> 'PENDING'
            or new."failure_code" is not null
            or new."processed_at" is not null
            or new."result_balance" is not null
            or new."result_currency" is not null then
            raise exception using errcode = '23514',
              message = 'Uma nova transação deve iniciar em PENDING';
          end if;
          return new;
        end if;

        if old."status" in ('PROCESSED', 'REJECTED', 'FAILED')
          and row(
            new."status", new."reference_transaction_id", new."failure_code",
            new."processed_at", new."result_balance", new."result_currency"
          ) is distinct from row(
            old."status", old."reference_transaction_id", old."failure_code",
            old."processed_at", old."result_balance", old."result_currency"
          ) then
          raise exception using errcode = '23514',
            message = 'Uma transação terminal e seu saldo de resposta são imutáveis';
        end if;

        if new."status" in ('PROCESSED', 'REJECTED')
          and new."result_balance" is null then
          raise exception using errcode = '23514',
            message = 'Uma transação processada ou rejeitada precisa guardar o saldo da resposta';
        end if;

        if old."result_balance" is not null
          and row(new."result_balance", new."result_currency")
            is distinct from row(old."result_balance", old."result_currency") then
          raise exception using errcode = '23514',
            message = 'O snapshot do resultado não pode ser substituído';
        end if;

        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger "wager_transactions_result_snapshot_guard"
      before insert or update on "wager_transactions"
      for each row execute function "protect_wager_result_snapshot"();
    `);
  }

  override down(): void {
    this.addSql(`
      drop trigger if exists "wager_transactions_result_snapshot_guard"
      on "wager_transactions";
    `);
    this.addSql('drop function if exists "protect_wager_result_snapshot"();');
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_result_snapshot_ck",
        drop column if exists "result_currency",
        drop column if exists "result_balance";
    `);
  }
}
