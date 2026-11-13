/**
 * Esta página processa BET, WIN e LOSS com idempotência e saldo observado persistidos.
 * Assinatura: Leonardo de Souza da Luz
 */
import { randomUUID } from 'node:crypto';
import { Money } from '../../domain/money/money.js';
import { InsufficientWalletBalanceError, Wallet } from '../../domain/wallet/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/ledger/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  type WagerTransactionProcessedData,
} from '../outbox/integration-events.js';
import type {
  PersistedWagerResult,
  WagerPersistencePort,
} from './wager-processing.port.js';
import { WagerIdentityAlreadyExistsError } from './wager-processing.port.js';

export type ProcessableWagerKind =
  | WagerTransactionKind.Bet
  | WagerTransactionKind.Win
  | WagerTransactionKind.Loss;

export interface ProcessWagerCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: ProcessableWagerKind;
  readonly money: Money;
}

export interface ProcessWagerResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus.Processed | WagerTransactionStatus.Rejected;
  readonly balance: Money;
  readonly idempotentReplay: boolean;
  readonly failureCode?: string;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('A chave de idempotência foi reutilizada com dados diferentes.');
    this.name = 'IdempotencyConflictError';
  }
}

export class WagerWalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`A carteira ${walletId} não existe.`);
    this.name = 'WagerWalletNotFoundError';
  }
}

export class WagerWalletOwnerMismatchError extends Error {
  constructor() {
    super('A carteira informada não pertence ao jogador informado.');
    this.name = 'WagerWalletOwnerMismatchError';
  }
}

export class WagerCurrencyMismatchError extends Error {
  constructor(walletCurrency: string, transactionCurrency: string) {
    super(
      `A moeda da carteira (${walletCurrency}) difere da moeda da transação (${transactionCurrency}).`,
    );
    this.name = 'WagerCurrencyMismatchError';
  }
}

export class WagerTransactionNotFinalizedError extends Error {
  constructor() {
    super('A transação associada à chave ainda não possui resultado final.');
    this.name = 'WagerTransactionNotFinalizedError';
  }
}

export class IdempotencyReplayUnavailableError extends Error {
  constructor() {
    super('O resultado histórico não contém o saldo necessário para uma repetição idempotente.');
    this.name = 'IdempotencyReplayUnavailableError';
  }
}

export class ProviderTransactionConflictError extends Error {
  constructor() {
    super('O identificador externo já está associado a outra transação do provedor.');
    this.name = 'ProviderTransactionConflictError';
  }
}

export class WagerPersistenceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WagerPersistenceInvariantError';
  }
}

function transactionEventData(
  transaction: WagerTransaction,
  balance: Money,
): WagerTransactionProcessedData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    balance: balance.toJSON(),
  };
}

export class ProcessWager {
  constructor(private readonly persistence: WagerPersistencePort) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const createdAt = new Date();
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      createdAt,
    });

    try {
      return await this.persistence.transaction(async (session) => {
        const existingBeforeLock = await session.findByIdempotencyKey(
          command.idempotencyKey,
        );
        if (existingBeforeLock) {
          return this.replay(existingBeforeLock, command.payloadHash);
        }

        const wallet = await session.findWalletForUpdate(command.walletId);
        if (!wallet) {
          throw new WagerWalletNotFoundError(command.walletId);
        }
        if (wallet.playerId !== command.playerId) {
          throw new WagerWalletOwnerMismatchError();
        }

        // A segunda leitura após o bloqueio da carteira fecha a corrida entre operações.
        const existingAfterLock = await session.findByIdempotencyKey(
          command.idempotencyKey,
        );
        if (existingAfterLock) {
          return this.replay(existingAfterLock, command.payloadHash);
        }

        if (wallet.currency !== command.money.currency) {
          throw new WagerCurrencyMismatchError(wallet.currency, command.money.currency);
        }

        await session.insertPendingTransaction(transaction);
        const occurredAt = new Date();
        const direction = transaction.ledgerDirectionFor();
        let entry: WalletLedgerEntry | undefined;

        try {
          // WIN credita, BET debita e LOSS mantém o saldo observado sem criar lançamento.
          if (transaction.affectsBalance()) {
            if (direction === LedgerDirection.Debit) {
              entry = wallet.debit({
                ledgerEntryId: randomUUID(),
                transactionId: transaction.id,
                money: command.money,
                occurredAt,
              });
            } else if (direction === LedgerDirection.Credit) {
              entry = wallet.credit({
                ledgerEntryId: randomUUID(),
                transactionId: transaction.id,
                money: command.money,
                occurredAt,
              });
            }
          }
        } catch (error) {
          if (
            command.kind !== WagerTransactionKind.Bet ||
            !(error instanceof InsufficientWalletBalanceError)
          ) {
            throw error;
          }

          const failureCode = 'INSUFFICIENT_FUNDS';
          transaction.reject(failureCode);
          await session.saveTransactionResult(transaction, wallet.balance);
          const rejectedEvent = WagerTransactionRejected.create({
            eventId: randomUUID(),
            aggregateId: transaction.id,
            correlationId: transaction.id,
            occurredAt,
            data: {
              ...transactionEventData(transaction, wallet.balance),
              failureCode,
            },
          });
          await session.insertOutboxMessage({
            transactionId: transaction.id,
            sequenceNumber: 1,
            event: rejectedEvent.toJSON(),
          });
          return {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Rejected,
            balance: wallet.balance,
            idempotentReplay: false,
            failureCode: transaction.failureCode,
          };
        }

        if (entry) {
          await session.saveWallet(wallet);
          await session.insertLedgerEntry(entry);
        }
        transaction.markProcessed(undefined, occurredAt);
        await session.saveTransactionResult(transaction, wallet.balance);
        const processedEvent = WagerTransactionProcessed.create({
          eventId: randomUUID(),
          aggregateId: transaction.id,
          correlationId: transaction.id,
          occurredAt,
          data: transactionEventData(transaction, wallet.balance),
        });
        await session.insertOutboxMessage({
          transactionId: transaction.id,
          sequenceNumber: 1,
          event: processedEvent.toJSON(),
        });

        if (entry) {
          const balanceChangedEvent = WalletBalanceChanged.create({
            eventId: randomUUID(),
            aggregateId: wallet.id,
            correlationId: transaction.id,
            occurredAt,
            data: {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction: entry.direction,
              money: entry.money.toJSON(),
              balanceBefore: entry.balanceBefore.toJSON(),
              balanceAfter: entry.balanceAfter.toJSON(),
              walletVersion: wallet.version,
            },
          });
          await session.insertOutboxMessage({
            transactionId: transaction.id,
            sequenceNumber: 2,
            event: balanceChangedEvent.toJSON(),
          });
        }

        return {
          transactionId: transaction.id,
          status: WagerTransactionStatus.Processed,
          balance: wallet.balance,
          idempotentReplay: false,
        };
      });
    } catch (error) {
      if (!(error instanceof WagerIdentityAlreadyExistsError)) {
        throw error;
      }

      if (error.kind === 'provider-transaction') {
        throw new ProviderTransactionConflictError();
      }

      const existing = await this.persistence.findByIdempotencyKey(
        command.idempotencyKey,
      );
      if (!existing) {
        throw new WagerPersistenceInvariantError(
          'A restrição de idempotência conflitou, mas a transação não foi encontrada após a reversão.',
        );
      }

      return this.replay(existing, command.payloadHash);
    }
  }

  private replay(
    existing: PersistedWagerResult,
    payloadHash: string,
  ): ProcessWagerResult {
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError();
    }
    if (
      existing.status !== WagerTransactionStatus.Processed &&
      existing.status !== WagerTransactionStatus.Rejected
    ) {
      throw new WagerTransactionNotFinalizedError();
    }
    if (!existing.balance) {
      throw new IdempotencyReplayUnavailableError();
    }

    return {
      transactionId: existing.transactionId,
      status: existing.status,
      balance: existing.balance,
      idempotentReplay: true,
      ...(existing.failureCode ? { failureCode: existing.failureCode } : {}),
    };
  }
}
