/**
 * Esta página consulta transações por ID interno ou chave externa do provedor.
 * Assinatura: Leonardo de Souza da Luz
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money/money.js';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import type {
  WagerReadPort,
  WagerTransactionPosition,
  WagerTransactionReadModel,
  WagerTransactionSlice,
} from '../../application/wagering/wager-read.port.js';
import { isTransientPostgreSqlFailure } from './postgres-errors.js';

interface WagerDatabaseRow {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly amount: string;
  readonly currency: string;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: string;
  readonly failureCode: string | null;
  readonly resultBalance: string | null;
  readonly resultCurrency: string | null;
  readonly createdAt: Date | string;
  readonly processedAt: Date | string | null;
}

interface WagerListDatabaseRow extends WagerDatabaseRow {
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

function toReadModel(row: WagerDatabaseRow): WagerTransactionReadModel {
  if ((row.resultBalance === null) !== (row.resultCurrency === null)) {
    throw new Error('O snapshot monetário persistido está incompleto.');
  }

  return {
    transactionId: row.transactionId,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    playerId: row.playerId,
    walletId: row.walletId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    money: Money.from({ amount: row.amount, currency: row.currency.trim() }).toJSON(),
    referenceExternalTransactionId: row.referenceExternalTransactionId,
    referenceTransactionId: row.referenceTransactionId,
    status: row.status,
    failureCode: row.failureCode,
    balance:
      row.resultBalance === null || row.resultCurrency === null
        ? null
        : Money.from({
            amount: row.resultBalance,
            currency: row.resultCurrency.trim(),
          }).toJSON(),
    createdAt: dateToIso(row.createdAt),
    processedAt: row.processedAt === null ? null : dateToIso(row.processedAt),
  };
}

export class PostgresWagerRead implements WagerReadPort {
  constructor(
    private readonly orm: MikroORM,
    private readonly schema?: string,
  ) {}

  async findById(transactionId: string): Promise<WagerTransactionReadModel | null> {
    return this.findOne(
      `where "id" = ?`,
      [transactionId],
    );
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionReadModel | null> {
    return this.findOne(
      `where "provider_id" = ? and "external_transaction_id" = ?`,
      [providerId, externalTransactionId],
    );
  }

  async findByWalletId(
    walletId: string,
    before: WagerTransactionPosition | undefined,
    limit: number,
  ): Promise<WagerTransactionSlice> {
    const entityManager = this.orm.em.fork();
    try {
      const cursorFilter = before
        ? `and ("created_at", "id") < (?::timestamptz, ?::uuid)`
        : '';
      const parameters: unknown[] = [walletId];
      if (before) {
        parameters.push(before.createdAt, before.transactionId);
      }
      parameters.push(limit + 1);

      const rows = await entityManager.getConnection().execute(
        `select
          "id" as "transactionId",
          "provider_id" as "providerId",
          "external_transaction_id" as "externalTransactionId",
          "player_id" as "playerId",
          "wallet_id" as "walletId",
          "round_id" as "roundId",
          "game_id" as "gameId",
          "kind",
          "amount"::text as "amount",
          "currency"::text as "currency",
          "reference_external_transaction_id" as "referenceExternalTransactionId",
          "reference_transaction_id" as "referenceTransactionId",
          "status",
          "failure_code" as "failureCode",
          "result_balance"::text as "resultBalance",
          "result_currency"::text as "resultCurrency",
          "created_at" as "createdAt",
          "processed_at" as "processedAt",
          to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt"
         from ${qualifiedTable(this.schema, 'wager_transactions')}
         where "wallet_id" = ?
         ${cursorFilter}
         order by "created_at" desc, "id" desc
         limit ?`,
        parameters,
        'all',
      );
      const databaseRows = rows as unknown as WagerListDatabaseRow[];
      const hasMore = databaseRows.length > limit;
      const pageRows = databaseRows.slice(0, limit);
      const lastRow = pageRows.at(-1);
      return {
        rows: pageRows.map(toReadModel),
        hasMore,
        lastPosition: lastRow
          ? {
              createdAt: lastRow.cursorCreatedAt,
              transactionId: lastRow.transactionId,
            }
          : null,
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

  private async findOne(
    whereClause: string,
    parameters: unknown[],
  ): Promise<WagerTransactionReadModel | null> {
    const entityManager = this.orm.em.fork();
    try {
      const rows = await entityManager.getConnection().execute(
        `select
          "id" as "transactionId",
          "provider_id" as "providerId",
          "external_transaction_id" as "externalTransactionId",
          "player_id" as "playerId",
          "wallet_id" as "walletId",
          "round_id" as "roundId",
          "game_id" as "gameId",
          "kind",
          "amount"::text as "amount",
          "currency"::text as "currency",
          "reference_external_transaction_id" as "referenceExternalTransactionId",
          "reference_transaction_id" as "referenceTransactionId",
          "status",
          "failure_code" as "failureCode",
          "result_balance"::text as "resultBalance",
          "result_currency"::text as "resultCurrency",
          "created_at" as "createdAt",
          "processed_at" as "processedAt"
         from ${qualifiedTable(this.schema, 'wager_transactions')}
         ${whereClause}`,
        parameters,
        'all',
      );
      const row = rows[0] as unknown as WagerDatabaseRow | undefined;
      return row ? toReadModel(row) : null;
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
