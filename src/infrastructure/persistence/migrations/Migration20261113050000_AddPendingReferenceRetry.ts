/**
 * Esta página adiciona o prazo e as tentativas duráveis das referências pendentes.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration20261113050000_AddPendingReferenceRetry extends Migration {
  override up(): void {
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_retry_attempts" integer not null default 0,
        add column "reference_next_attempt_at" timestamptz null,
        add column "reference_expires_at" timestamptz null;
    `);
    this.addSql(`
      update "wager_transactions"
      set "reference_next_attempt_at" = now() + interval '1 second',
          "reference_expires_at" = now() + interval '24 hours'
      where "status" = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_reference_retry_ck" check (
          ("status" = 'PENDING_REFERENCE'
            and "reference_external_transaction_id" is not null
            and "reference_next_attempt_at" is not null
            and "reference_expires_at" is not null
            and "reference_next_attempt_at" <= "reference_expires_at")
          or ("status" <> 'PENDING_REFERENCE'
            and "reference_next_attempt_at" is null
            and "reference_expires_at" is null)
        ),
        add constraint "wager_transactions_reference_retry_attempts_ck"
          check ("reference_retry_attempts" >= 0);
    `);
    this.addSql(`
      create index "wager_transactions_pending_reference_due_idx"
        on "wager_transactions" (
          "reference_next_attempt_at", "wallet_id", "id"
        )
        where "status" = 'PENDING_REFERENCE';
    `);
  }

  override down(): void {
    this.addSql('drop index if exists "wager_transactions_pending_reference_due_idx";');
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_reference_retry_ck",
        drop constraint if exists "wager_transactions_reference_retry_attempts_ck",
        drop column if exists "reference_next_attempt_at",
        drop column if exists "reference_expires_at",
        drop column if exists "reference_retry_attempts";
    `);
  }
}
