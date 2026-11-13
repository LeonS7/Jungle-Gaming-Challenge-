/**
 * Esta página reforça a constraint que mantém completo o snapshot de resposta.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration20261113020000_StrengthenWagerResultSnapshot extends Migration {
  override up(): void {
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_result_snapshot_ck",
        add constraint "wager_transactions_result_snapshot_ck" check (
          ("result_balance" is null) = ("result_currency" is null)
          and (
            "result_balance" is null
            or (
              "status" in ('PROCESSED', 'REJECTED')
              and "result_balance" >= 0
              and "result_currency" = "currency"
            )
          )
        );
    `);
  }

  override down(): void {
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_result_snapshot_ck",
        add constraint "wager_transactions_result_snapshot_ck" check (
          ("result_balance" is null and "result_currency" is null)
          or (
            "status" in ('PROCESSED', 'REJECTED')
            and "result_balance" >= 0
            and "result_currency" = "currency"
          )
        );
    `);
  }
}
