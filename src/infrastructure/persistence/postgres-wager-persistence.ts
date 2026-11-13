/**
 * Esta página persiste BET, WIN e LOSS em uma transação MikroORM e bloqueia a carteira usada.
 * Assinatura: Leonardo de Souza da Luz
 */
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/ledger/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import { WagerPersistenceInvariantError } from '../../application/wagering/process-wager.js';
import type { OutboxMessageToAppend } from '../../application/outbox/integration-events.js';
import {
  WagerIdentityAlreadyExistsError,
  type WagerPersistencePort,
  type WagerTransactionSession,
  type PersistedWagerResult,
} from '../../application/wagering/wager-processing.port.js';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import {
  isTransientPostgreSqlFailure,
  readPostgreSqlErrorMetadata,
} from './postgres-errors.js';
import { insertOutboxMessage as persistOutboxMessage } from './postgres-outbox-writer.js';

interface ExistingWagerRow {
  readonly transactionId: string;
  readonly payloadHash: string;
  readonly status: string;
  readonly resultBalance: string | null;
  readonly resultCurrency: string | null;
  readonly failureCode: string | null;
}

interface WalletRow {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: string;
  readonly version: number;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

function parseDatabaseDate(value: Date | string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new WagerPersistenceInvariantError(
      'O PostgreSQL retornou uma data inválida para a carteira.',
    );
  }
  return parsed;
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

class PostgresWagerTransactionSession implements WagerTransactionSession {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly schema?: string,
  ) {}

  private execute(query: string, params: unknown[] = []) {
    return this.entityManager.getConnection().execute(
      query,
      params,
      'all',
      this.entityManager.getTransactionContext(),
    );
  }

  async findByIdempotencyKey(key: string): Promise<PersistedWagerResult | null> {
    return this.readByIdempotencyKey(key);
  }

  async findWalletForUpdate(walletId: string): Promise<Wallet | null> {
    const rows = await this.execute(
      `select
        "id",
        "player_id" as "playerId",
        "currency"::text as "currency",
        "balance"::text as "balance",
        "version",
        "created_at" as "createdAt",
        "updated_at" as "updatedAt"
       from ${qualifiedTable(this.schema, 'wallets')}
       where "id" = ?
       for update`,
      [walletId],
    );
    const row = rows[0] as unknown as WalletRow | undefined;
    if (!row) {
      return null;
    }

    const currency = row.currency.trim();
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency,
      balance: Money.from({ amount: row.balance, currency }),
      version: row.version,
      createdAt: parseDatabaseDate(row.createdAt),
      updatedAt: parseDatabaseDate(row.updatedAt),
    });
  }

  async insertPendingTransaction(transaction: WagerTransaction): Promise<void> {
    const money = transaction.money.toJSON();
    try {
      await this.execute(
        `insert into ${qualifiedTable(this.schema, 'wager_transactions')} (
          "id", "provider_id", "external_transaction_id", "idempotency_key", "payload_hash",
          "wallet_id", "player_id", "currency", "round_id", "game_id", "kind", "amount",
          "reference_external_transaction_id", "reference_transaction_id", "status",
          "failure_code", "created_at", "processed_at"
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', null, ?, null)`,
        [
          transaction.id,
          transaction.providerId,
          transaction.externalTransactionId,
          transaction.idempotencyKey,
          transaction.payloadHash,
          transaction.walletId,
          transaction.playerId,
          money.currency,
          transaction.roundId,
          transaction.gameId,
          transaction.kind,
          money.amount,
          transaction.referenceExternalTransactionId ?? null,
          transaction.referenceTransactionId ?? null,
          transaction.createdAt,
        ],
      );
    } catch (error) {
      const metadata = readPostgreSqlErrorMetadata(error);
      if (
        metadata.code === '23505' &&
        metadata.constraint === 'wager_transactions_idempotency_key_uq'
      ) {
        throw new WagerIdentityAlreadyExistsError('idempotency-key');
      }
      if (
        metadata.code === '23505' &&
        metadata.constraint === 'wager_transactions_provider_external_uq'
      ) {
        throw new WagerIdentityAlreadyExistsError('provider-transaction');
      }

      throw error;
    }
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const updated = await this.execute(
      `update ${qualifiedTable(this.schema, 'wallets')}
       set "balance" = ?, "version" = ?, "updated_at" = ?
       where "id" = ? and "version" = ?
       returning "id"`,
      [
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.updatedAt,
        wallet.id,
        wallet.version - 1,
      ],
    );
    if (updated.length !== 1) {
      throw new WagerPersistenceInvariantError(
        'A carteira não avançou da versão lida sob bloqueio para a nova versão.',
      );
    }
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    const money = entry.money.toJSON();
    const before = entry.balanceBefore.toJSON();
    const after = entry.balanceAfter.toJSON();
    await this.execute(
      `insert into ${qualifiedTable(this.schema, 'wallet_ledger_entries')} (
        "id", "wallet_id", "transaction_id", "direction", "amount", "currency",
        "balance_before", "balance_after", "created_at"
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        money.amount,
        money.currency,
        before.amount,
        after.amount,
        entry.createdAt,
      ],
    );
  }

  async insertOutboxMessage(
    message: OutboxMessageToAppend,
  ): Promise<void> {
    await persistOutboxMessage(this.entityManager, this.schema, message);
  }

  async saveTransactionResult(
    transaction: WagerTransaction,
    observedBalance: Money,
  ): Promise<void> {
    if (
      transaction.status !== WagerTransactionStatus.Processed &&
      transaction.status !== WagerTransactionStatus.Rejected
    ) {
      throw new WagerPersistenceInvariantError(
        'Somente transações processadas ou rejeitadas podem guardar saldo de resposta.',
      );
    }
    if (observedBalance.currency !== transaction.money.currency) {
      throw new WagerPersistenceInvariantError(
        'O saldo de resposta e a transação precisam usar a mesma moeda.',
      );
    }

    const updated = await this.execute(
      `update ${qualifiedTable(this.schema, 'wager_transactions')}
       set "status" = ?, "reference_transaction_id" = ?, "failure_code" = ?,
           "processed_at" = ?, "result_balance" = ?, "result_currency" = ?
       where "id" = ?
       returning "id"`,
      [
        transaction.status,
        transaction.referenceTransactionId ?? null,
        transaction.failureCode ?? null,
        transaction.processedAt ?? null,
        observedBalance.toJSON().amount,
        observedBalance.currency,
        transaction.id,
      ],
    );
    if (updated.length !== 1) {
      throw new WagerPersistenceInvariantError(
        'A transação pendente desapareceu antes do registro do resultado.',
      );
    }
  }

  private async readByIdempotencyKey(
    key: string,
  ): Promise<PersistedWagerResult | null> {
    const rows = await this.execute(
      `select
        "id" as "transactionId",
        "payload_hash" as "payloadHash",
        "status",
        "result_balance"::text as "resultBalance",
        "result_currency"::text as "resultCurrency",
        "failure_code" as "failureCode"
       from ${qualifiedTable(this.schema, 'wager_transactions')}
       where "idempotency_key" = ?`,
      [key],
    );
    const row = rows[0] as unknown as ExistingWagerRow | undefined;
    if (!row) {
      return null;
    }

    const balance =
      row.resultBalance !== null && row.resultCurrency !== null
        ? Money.from({
            amount: row.resultBalance,
            currency: row.resultCurrency.trim(),
          })
        : null;

    return {
      transactionId: row.transactionId,
      payloadHash: row.payloadHash,
      status: row.status as WagerTransactionStatus,
      balance,
      failureCode: row.failureCode,
    };
  }
}

/** Adapter PostgreSQL para a porta transacional do caso de uso de wagering. */
export class PostgresWagerPersistence implements WagerPersistencePort {
  constructor(
    private readonly orm: MikroORM,
    private readonly schema?: string,
  ) {}

  async transaction<T>(
    operation: (session: WagerTransactionSession) => Promise<T>,
  ): Promise<T> {
    const entityManager = this.orm.em.fork();
    try {
      return await entityManager.transactional((transactionalManager) =>
        operation(new PostgresWagerTransactionSession(transactionalManager, this.schema)),
      );
    } catch (error) {
      if (isTransientPostgreSqlFailure(error)) {
        throw new PersistenceUnavailableError();
      }
      throw error;
    } finally {
      entityManager.clear();
    }
  }

  async findByIdempotencyKey(key: string): Promise<PersistedWagerResult | null> {
    const entityManager = this.orm.em.fork();
    try {
      return await new PostgresWagerTransactionSession(
        entityManager,
        this.schema,
      ).findByIdempotencyKey(key);
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
