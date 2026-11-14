/**
 * Esta página persiste wagering, referências e reversões em transação PostgreSQL.
 * Assinatura: Leonardo de Souza da Luz
 */
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money/money.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/ledger/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from '../../domain/wagering/wager-transaction.js';
import {
  PendingReferenceRetry,
  PENDING_REFERENCE_TTL_SECONDS,
} from '../../domain/wagering/pending-reference-retry.js';
import { WagerPersistenceInvariantError } from '../../application/wagering/process-wager.js';
import type { OutboxMessageToAppend } from '../../application/outbox/integration-events.js';
import {
  WagerIdentityAlreadyExistsError,
  type WagerPersistencePort,
  type WagerTransactionSession,
  type InboxMessageRegistration,
  type PersistedWagerResult,
  type PendingReferenceWorkItem,
} from '../../application/wagering/wager-processing.port.js';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import type {
  LockConflictType,
  OperationalMetricsPort,
} from '../../application/observability/operational-metrics.port.js';
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

interface ReferenceWagerRow {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly currency: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly amount: string;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: string;
  readonly failureCode: string | null;
  readonly createdAt: Date | string;
  readonly processedAt: Date | string | null;
}

interface PendingReferenceRow extends ReferenceWagerRow {
  readonly retryAttempts: number;
  readonly nextAttemptAt: Date | string;
  readonly expiresAt: Date | string;
  readonly databaseNow: Date | string;
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

function lockConflictType(error: unknown): LockConflictType | undefined {
  const code = readPostgreSqlErrorMetadata(error).code;
  if (code === '40P01') {
    return 'deadlock';
  }
  if (code === '40001') {
    return 'serialization';
  }
  if (code === '55P03') {
    return 'lock_not_available';
  }
  return undefined;
}

class PostgresWagerTransactionSession implements WagerTransactionSession {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly schema?: string,
    private readonly metrics?: OperationalMetricsPort,
  ) {}

  private execute(query: string, params: unknown[] = []) {
    return this.entityManager.getConnection().execute(
      query,
      params,
      'all',
      this.entityManager.getTransactionContext(),
    );
  }

  async registerInboxMessage(
    message: InboxMessage,
  ): Promise<InboxMessageRegistration> {
    const inserted = await this.execute(
      `insert into ${qualifiedTable(this.schema, 'inbox_messages')} (
        "consumer_name", "message_id", "payload_hash", "received_at"
      ) values (?, ?, ?, ?)
      on conflict ("consumer_name", "message_id") do nothing
      returning "message_id"`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (inserted.length === 1) {
      return 'REGISTERED';
    }

    const existing = await this.execute(
      `select "payload_hash" as "payloadHash", "processed_at" as "processedAt"
       from ${qualifiedTable(this.schema, 'inbox_messages')}
       where "consumer_name" = ? and "message_id" = ?
       for update`,
      [message.consumerName, message.messageId],
    );
    const row = existing[0] as unknown as {
      readonly payloadHash: string;
      readonly processedAt: Date | string | null;
    } | undefined;
    if (!row) {
      throw new WagerPersistenceInvariantError(
        'Uma mensagem conflitante da inbox não foi encontrada para leitura.',
      );
    }
    if (row.payloadHash.trim() !== message.payloadHash) {
      return 'PAYLOAD_CONFLICT';
    }
    return row.processedAt === null ? 'INCOMPLETE' : 'DUPLICATE';
  }

  async markInboxMessageProcessed(message: InboxMessage): Promise<void> {
    if (!message.isProcessed() || !message.processedAt) {
      throw new WagerPersistenceInvariantError(
        'A mensagem da inbox precisa ser marcada como processada antes da persistência.',
      );
    }
    const updated = await this.execute(
      `update ${qualifiedTable(this.schema, 'inbox_messages')}
       set "processed_at" = ?
       where "consumer_name" = ? and "message_id" = ?
         and "payload_hash" = ? and "processed_at" is null
       returning "message_id"`,
      [
        message.processedAt,
        message.consumerName,
        message.messageId,
        message.payloadHash,
      ],
    );
    if (updated.length !== 1) {
      throw new WagerPersistenceInvariantError(
        'A mensagem da inbox não pôde ser concluída na transação atual.',
      );
    }
  }

  async findByIdempotencyKey(key: string): Promise<PersistedWagerResult | null> {
    return this.readByIdempotencyKey(key);
  }

  async findWalletForUpdate(walletId: string): Promise<Wallet | null> {
    const startedAt = performance.now();
    let rows: unknown[];
    try {
      rows = await this.execute(
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
    } finally {
      this.metrics?.recordWalletLockWait(
        (performance.now() - startedAt) / 1000,
      );
    }
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

  async findReference(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const rows = await this.execute(
      `select
        "id",
        "provider_id" as "providerId",
        "external_transaction_id" as "externalTransactionId",
        "idempotency_key" as "idempotencyKey",
        "payload_hash" as "payloadHash",
        "wallet_id" as "walletId",
        "player_id" as "playerId",
        "currency"::text as "currency",
        "round_id" as "roundId",
        "game_id" as "gameId",
        "kind",
        "amount"::text as "amount",
        "reference_external_transaction_id" as "referenceExternalTransactionId",
        "reference_transaction_id" as "referenceTransactionId",
        "status",
        "failure_code" as "failureCode",
        "created_at" as "createdAt",
        "processed_at" as "processedAt"
       from ${qualifiedTable(this.schema, 'wager_transactions')}
       where "provider_id" = ? and "external_transaction_id" = ?`,
      [providerId, externalTransactionId],
    );
    const row = rows[0] as unknown as ReferenceWagerRow | undefined;
    if (!row) {
      return null;
    }

    const state: WagerTransactionState = {
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money: Money.from({
        amount: row.amount,
        currency: row.currency.trim(),
      }),
      ...(row.referenceExternalTransactionId !== null
        ? { referenceExternalTransactionId: row.referenceExternalTransactionId }
        : {}),
      createdAt: parseDatabaseDate(row.createdAt),
      status: row.status as WagerTransactionStatus,
      ...(row.referenceTransactionId !== null
        ? { referenceTransactionId: row.referenceTransactionId }
        : {}),
      ...(row.failureCode !== null ? { failureCode: row.failureCode } : {}),
      ...(row.processedAt !== null
        ? { processedAt: parseDatabaseDate(row.processedAt) }
        : {}),
    };
    return WagerTransaction.rehydrate(state);
  }

  async hasProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  ): Promise<boolean> {
    const rows = await this.execute(
      `select "id"
       from ${qualifiedTable(this.schema, 'wager_transactions')}
       where "reference_transaction_id" = ?
         and "kind" = ?
         and "status" = 'PROCESSED'
       limit 1`,
      [referenceTransactionId, kind],
    );
    return rows.length > 0;
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

  async savePendingReference(transaction: WagerTransaction): Promise<void> {
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      transaction.referenceTransactionId !== undefined
    ) {
      throw new WagerPersistenceInvariantError(
        'Somente uma transação sem referência resolvida pode aguardar uma referência.',
      );
    }

    const updated = await this.execute(
      `update ${qualifiedTable(this.schema, 'wager_transactions')}
       set "status" = 'PENDING_REFERENCE',
           "reference_retry_attempts" = 0,
           "reference_next_attempt_at" = now() + (? * interval '1 second'),
           "reference_expires_at" = now() + (? * interval '1 second')
       where "id" = ? and "status" = 'PENDING'
       returning "id"`,
      [1, PENDING_REFERENCE_TTL_SECONDS, transaction.id],
    );
    if (updated.length !== 1) {
      throw new WagerPersistenceInvariantError(
        'A transação pendente desapareceu antes de aguardar a referência.',
      );
    }
  }

  async findDuePendingReferences(
    limit: number,
  ): Promise<readonly PendingReferenceWorkItem[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new WagerPersistenceInvariantError(
        'O lote de referências pendentes deve conter de 1 a 100 registros.',
      );
    }
    const rows = await this.execute(
      `select
        "id",
        "provider_id" as "providerId",
        "external_transaction_id" as "externalTransactionId",
        "idempotency_key" as "idempotencyKey",
        "payload_hash" as "payloadHash",
        "wallet_id" as "walletId",
        "player_id" as "playerId",
        "currency"::text as "currency",
        "round_id" as "roundId",
        "game_id" as "gameId",
        "kind",
        "amount"::text as "amount",
        "reference_external_transaction_id" as "referenceExternalTransactionId",
        "reference_transaction_id" as "referenceTransactionId",
        "status",
        "failure_code" as "failureCode",
        "created_at" as "createdAt",
        "processed_at" as "processedAt",
        "reference_retry_attempts" as "retryAttempts",
        "reference_next_attempt_at" as "nextAttemptAt",
        "reference_expires_at" as "expiresAt",
        now() as "databaseNow"
       from ${qualifiedTable(this.schema, 'wager_transactions')}
       where "status" = 'PENDING_REFERENCE'
         and "reference_next_attempt_at" <= now()
       order by "wallet_id", "reference_next_attempt_at", "id"
       limit ?
       for update skip locked`,
      [limit],
    );

    return (rows as unknown as PendingReferenceRow[]).map((row) => {
      const currency = row.currency.trim();
      const state: WagerTransactionState = {
        id: row.id,
        providerId: row.providerId,
        externalTransactionId: row.externalTransactionId,
        idempotencyKey: row.idempotencyKey,
        payloadHash: row.payloadHash,
        walletId: row.walletId,
        playerId: row.playerId,
        roundId: row.roundId,
        gameId: row.gameId,
        kind: row.kind as WagerTransactionKind,
        money: Money.from({ amount: row.amount, currency }),
        ...(row.referenceExternalTransactionId !== null
          ? { referenceExternalTransactionId: row.referenceExternalTransactionId }
          : {}),
        createdAt: parseDatabaseDate(row.createdAt),
        status: row.status as WagerTransactionStatus,
        ...(row.referenceTransactionId !== null
          ? { referenceTransactionId: row.referenceTransactionId }
          : {}),
        ...(row.failureCode !== null ? { failureCode: row.failureCode } : {}),
        ...(row.processedAt !== null
          ? { processedAt: parseDatabaseDate(row.processedAt) }
          : {}),
      };
      return {
        transaction: WagerTransaction.rehydrate(state),
        retry: PendingReferenceRetry.rehydrate({
          attempts: row.retryAttempts,
          nextAttemptAt: parseDatabaseDate(row.nextAttemptAt),
          expiresAt: parseDatabaseDate(row.expiresAt),
        }),
        databaseNow: parseDatabaseDate(row.databaseNow),
      };
    });
  }

  async schedulePendingReferenceRetry(
    transactionId: string,
    attempts: number,
    delaySeconds: number,
  ): Promise<void> {
    const updated = await this.execute(
      `update ${qualifiedTable(this.schema, 'wager_transactions')}
       set "reference_retry_attempts" = ?,
           "reference_next_attempt_at" = least(
             now() + (? * interval '1 second'), "reference_expires_at"
           )
       where "id" = ? and "status" = 'PENDING_REFERENCE'
       returning "id"`,
      [attempts, delaySeconds, transactionId],
    );
    if (updated.length !== 1) {
      throw new WagerPersistenceInvariantError(
        'A referência pendente desapareceu antes do agendamento da próxima tentativa.',
      );
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
           "processed_at" = ?, "result_balance" = ?, "result_currency" = ?,
           "reference_next_attempt_at" = null, "reference_expires_at" = null
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
    private readonly metrics?: OperationalMetricsPort,
  ) {}

  async transaction<T>(
    operation: (session: WagerTransactionSession) => Promise<T>,
  ): Promise<T> {
    const entityManager = this.orm.em.fork();
    try {
      return await entityManager.transactional((transactionalManager) =>
        operation(new PostgresWagerTransactionSession(
          transactionalManager,
          this.schema,
          this.metrics,
        )),
      );
    } catch (error) {
      const conflictType = lockConflictType(error);
      if (conflictType) {
        this.metrics?.recordLockConflict(conflictType);
      }
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
        this.metrics,
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
