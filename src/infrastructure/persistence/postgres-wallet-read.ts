/**
 * Esta página lê carteiras e páginas imutáveis do ledger no PostgreSQL.
 * Assinatura: Leonardo de Souza da Luz
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money/money.js';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import type {
  WalletLedgerPosition,
  WalletLedgerRow,
  WalletLedgerSlice,
  WalletReadModel,
  WalletReadPort,
} from '../../application/wallets/wallet-read.port.js';
import { isTransientPostgreSqlFailure } from './postgres-errors.js';

interface WalletDatabaseRow {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: string;
  readonly version: number;
}

interface LedgerDatabaseRow {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: string;
  readonly amount: string;
  readonly currency: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly createdAt: Date | string;
  readonly cursorCreatedAt: string;
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

function dateToIso(value: Date | string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('O PostgreSQL retornou uma data inválida para uma consulta.');
  }
  return date.toISOString();
}

function toLedgerRow(row: LedgerDatabaseRow): WalletLedgerRow {
  const currency = row.currency.trim();
  return {
    id: row.id,
    transactionId: row.transactionId,
    direction: row.direction,
    money: Money.from({ amount: row.amount, currency }).toJSON(),
    balanceBefore: Money.from({ amount: row.balanceBefore, currency }).toJSON(),
    balanceAfter: Money.from({ amount: row.balanceAfter, currency }).toJSON(),
    createdAt: dateToIso(row.createdAt),
    cursorCreatedAt: row.cursorCreatedAt,
  };
}

export class PostgresWalletRead implements WalletReadPort {
  constructor(
    private readonly orm: MikroORM,
    private readonly schema?: string,
  ) {}

  async findWalletById(walletId: string): Promise<WalletReadModel | null> {
    const entityManager = this.orm.em.fork();
    try {
      const rows = await entityManager.getConnection().execute(
        `select
          "id",
          "player_id" as "playerId",
          "currency"::text as "currency",
          "balance"::text as "balance",
          "version"
         from ${qualifiedTable(this.schema, 'wallets')}
         where "id" = ?`,
        [walletId],
        'all',
      );
      const row = rows[0] as unknown as WalletDatabaseRow | undefined;
      if (!row) {
        return null;
      }

      const currency = row.currency.trim();
      return {
        id: row.id,
        playerId: row.playerId,
        balance: Money.from({ amount: row.balance, currency }).toJSON(),
        version: row.version,
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

  async findLedgerRows(
    walletId: string,
    before: WalletLedgerPosition | undefined,
    limit: number,
  ): Promise<WalletLedgerSlice> {
    const entityManager = this.orm.em.fork();
    try {
      const cursorFilter = before
        ? `and ("created_at", "id") < (?::timestamptz, ?::uuid)`
        : '';
      const parameters: unknown[] = [walletId];
      if (before) {
        parameters.push(before.createdAt, before.id);
      }
      parameters.push(limit + 1);

      const rows = await entityManager.getConnection().execute(
        `select
          "id",
          "transaction_id" as "transactionId",
          "direction",
          "amount"::text as "amount",
          "currency"::text as "currency",
          "balance_before"::text as "balanceBefore",
          "balance_after"::text as "balanceAfter",
          "created_at" as "createdAt",
          to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt"
         from ${qualifiedTable(this.schema, 'wallet_ledger_entries')}
         where "wallet_id" = ?
         ${cursorFilter}
         order by "created_at" desc, "id" desc
         limit ?`,
        parameters,
        'all',
      );
      const databaseRows = rows as unknown as LedgerDatabaseRow[];
      const hasMore = databaseRows.length > limit;
      return {
        rows: databaseRows.slice(0, limit).map(toLedgerRow),
        hasMore,
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
