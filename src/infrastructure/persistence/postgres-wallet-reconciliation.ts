/**
 * Esta página reconstitui o saldo por soma NUMERIC e lê o saldo materializado no PostgreSQL.
 * Assinatura: Leonardo de Souza da Luz
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import type {
  WalletReconciliationReadPort,
  WalletReconciliationSnapshot,
} from '../../application/wallets/wallet-reconciliation.port.js';
import { isTransientPostgreSqlFailure } from './postgres-errors.js';

interface WalletReconciliationRow {
  readonly walletId: string;
  readonly currency: string;
  readonly storedBalance: string;
  readonly calculatedBalance: string;
  readonly checkedEntries: string;
}

function qualifiedTable(schema: string | undefined, table: string): string {
  if (!schema) {
    return `"${table}"`;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('O nome do schema PostgreSQL contém caracteres inválidos.');
  }
  return `"${schema}"."${table}"`;
}

export class PostgresWalletReconciliation implements WalletReconciliationReadPort {
  constructor(
    private readonly orm: MikroORM,
    private readonly schema?: string,
  ) {}

  async findSnapshot(walletId: string): Promise<WalletReconciliationSnapshot | null> {
    const entityManager = this.orm.em.fork();
    try {
      const rows = await entityManager.getConnection().execute(
        `select
          wallet."id" as "walletId",
          wallet."currency"::text as "currency",
          wallet."balance"::text as "storedBalance",
          coalesce(
            sum(case ledger."direction"
              when 'CREDIT' then ledger."amount"
              when 'DEBIT' then -ledger."amount"
              else 0::numeric
            end),
            0::numeric
          )::numeric(30, 2)::text as "calculatedBalance",
          count(ledger."id")::text as "checkedEntries"
         from ${qualifiedTable(this.schema, 'wallets')} wallet
         left join ${qualifiedTable(this.schema, 'wallet_ledger_entries')} ledger
           on ledger."wallet_id" = wallet."id"
         where wallet."id" = ?
         group by wallet."id"`,
        [walletId],
        'all',
      );
      const row = rows[0] as unknown as WalletReconciliationRow | undefined;
      if (!row) {
        return null;
      }
      const checkedEntries = Number(row.checkedEntries);
      if (!Number.isSafeInteger(checkedEntries) || checkedEntries < 0) {
        throw new Error('O PostgreSQL retornou uma contagem inválida de lançamentos.');
      }
      return {
        walletId: row.walletId,
        currency: row.currency.trim(),
        storedBalance: row.storedBalance,
        calculatedBalance: row.calculatedBalance,
        checkedEntries,
      };
    } catch (error) {
      if (isTransientPostgreSqlFailure(error)) {
        throw new PersistenceUnavailableError();
      }
      throw error;
    } finally {
      entityManager.clear();
    }
  }
}
