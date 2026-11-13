/**
 * Esta página grava Wallet e registros de abertura na mesma transação PostgreSQL.
 * Assinatura: Leonardo de Souza da Luz
 */
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import {
  WalletAlreadyExistsError,
  WalletPersistenceInvariantError,
  type OpenWalletPersistencePort,
  type WalletOpeningRecords,
} from '../../application/wallets/open-wallet.port.js';
import { LedgerDirection } from '../../domain/ledger/wallet-ledger-entry.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';
import { isTransientPostgreSqlFailure, readPostgreSqlErrorMetadata } from './postgres-errors.js';
import { insertOutboxMessage as persistOutboxMessage } from './postgres-outbox-writer.js';

function qualifiedTable(schema: string | undefined, table: string): string {
  if (!schema) {
    return `"${table}"`;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('O nome do schema PostgreSQL contém caracteres inválidos.');
  }
  return `"${schema}"."${table}"`;
}

class PostgresWalletOpeningSession {
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

  async create(wallet: Wallet, opening?: WalletOpeningRecords): Promise<void> {
    const walletBalance = wallet.balance.toJSON();
    if (wallet.balance.isPositive() !== Boolean(opening)) {
      throw new WalletPersistenceInvariantError(
        'O saldo inicial positivo precisa de registros OPENING, e saldo zero não pode gerá-los.',
      );
    }

    if (opening) {
      this.assertOpeningMatchesWallet(wallet, opening, walletBalance.amount, walletBalance.currency);
    }

    await this.execute(
      `insert into ${qualifiedTable(this.schema, 'wallets')} (
        "id", "player_id", "currency", "balance", "version", "created_at", "updated_at"
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        wallet.id,
        wallet.playerId,
        walletBalance.currency,
        walletBalance.amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );

    if (!opening) {
      return;
    }

    const { transaction, ledgerEntry } = opening;
    const transactionMoney = transaction.money.toJSON();
    const ledgerMoney = ledgerEntry.money.toJSON();
    const ledgerBefore = ledgerEntry.balanceBefore.toJSON();
    const ledgerAfter = ledgerEntry.balanceAfter.toJSON();
    await this.execute(
      `insert into ${qualifiedTable(this.schema, 'wager_transactions')} (
        "id", "provider_id", "external_transaction_id", "idempotency_key", "payload_hash",
        "wallet_id", "player_id", "currency", "round_id", "game_id", "kind", "amount",
        "reference_external_transaction_id", "reference_transaction_id", "status",
        "failure_code", "created_at", "processed_at"
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, 'PENDING', null, ?, null)`,
      [
        transaction.id,
        transaction.providerId,
        transaction.externalTransactionId,
        transaction.idempotencyKey,
        transaction.payloadHash,
        transaction.walletId,
        transaction.playerId,
        transactionMoney.currency,
        transaction.roundId,
        transaction.gameId,
        WagerTransactionKind.Opening,
        transactionMoney.amount,
        transaction.createdAt,
      ],
    );
    await this.execute(
      `insert into ${qualifiedTable(this.schema, 'wallet_ledger_entries')} (
        "id", "wallet_id", "transaction_id", "direction", "amount", "currency",
        "balance_before", "balance_after", "created_at"
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ledgerEntry.id,
        ledgerEntry.walletId,
        ledgerEntry.transactionId,
        ledgerEntry.direction,
        ledgerMoney.amount,
        ledgerMoney.currency,
        ledgerBefore.amount,
        ledgerAfter.amount,
        ledgerEntry.createdAt,
      ],
    );
    await this.execute(
      `update ${qualifiedTable(this.schema, 'wager_transactions')}
       set "status" = 'PROCESSED', "processed_at" = ?,
           "result_balance" = ?, "result_currency" = ?
       where "id" = ?`,
      [transaction.processedAt, walletBalance.amount, walletBalance.currency, transaction.id],
    );
    for (const message of opening.outboxMessages) {
      await persistOutboxMessage(this.entityManager, this.schema, message);
    }
  }

  private assertOpeningMatchesWallet(
    wallet: Wallet,
    opening: WalletOpeningRecords,
    walletBalanceAmount: string,
    walletCurrency: string,
  ): void {
    const { transaction, ledgerEntry } = opening;
    const transactionMoney = transaction.money.toJSON();
    const ledgerMoney = ledgerEntry.money.toJSON();
    const ledgerBefore = ledgerEntry.balanceBefore.toJSON();
    const ledgerAfter = ledgerEntry.balanceAfter.toJSON();
    if (
      transaction.kind !== WagerTransactionKind.Opening ||
      transaction.status !== WagerTransactionStatus.Processed ||
      opening.outboxMessages.length !== 2 ||
      opening.outboxMessages[0]?.transactionId !== transaction.id ||
      opening.outboxMessages[0]?.sequenceNumber !== 1 ||
      opening.outboxMessages[0]?.event.eventType !== 'WagerTransactionProcessed' ||
      opening.outboxMessages[1]?.transactionId !== transaction.id ||
      opening.outboxMessages[1]?.sequenceNumber !== 2 ||
      opening.outboxMessages[1]?.event.eventType !== 'WalletBalanceChanged' ||
      transaction.walletId !== wallet.id ||
      transaction.playerId !== wallet.playerId ||
      !transaction.money.equals(wallet.balance) ||
      ledgerEntry.direction !== LedgerDirection.Credit ||
      ledgerEntry.walletId !== wallet.id ||
      ledgerEntry.transactionId !== transaction.id ||
      !ledgerEntry.isBalanced() ||
      ledgerBefore.amount !== '0.00' ||
      ledgerAfter.amount !== walletBalanceAmount ||
      ledgerMoney.currency !== walletCurrency ||
      transactionMoney.amount !== walletBalanceAmount ||
      transactionMoney.currency !== walletCurrency
    ) {
      throw new WalletPersistenceInvariantError(
        'Os registros OPENING não correspondem à carteira e ao saldo inicial.',
      );
    }
  }
}

export class PostgresWalletOpeningPersistence implements OpenWalletPersistencePort {
  constructor(
    private readonly orm: MikroORM,
    private readonly schema?: string,
  ) {}

  async create(wallet: Wallet, opening?: WalletOpeningRecords): Promise<void> {
    const entityManager = this.orm.em.fork();
    try {
      await entityManager.transactional((transactionalManager) =>
        new PostgresWalletOpeningSession(transactionalManager, this.schema).create(
          wallet,
          opening,
        ),
      );
    } catch (error) {
      const metadata = readPostgreSqlErrorMetadata(error);
      if (
        metadata.code === '23505' &&
        metadata.constraint === 'wallets_player_currency_uq'
      ) {
        throw new WalletAlreadyExistsError();
      }
      if (isTransientPostgreSqlFailure(error)) {
        throw new PersistenceUnavailableError();
      }
      throw error;
    } finally {
      entityManager.clear();
    }
  }
}
