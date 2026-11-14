/**
 * Esta página processa wagering, referências, reversões e idempotência em transações.
 * Assinatura: Leonardo de Souza da Luz
 */
import { randomUUID } from 'node:crypto';
import { Money } from '../../domain/money/money.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { InsufficientWalletBalanceError, Wallet } from '../../domain/wallet/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/ledger/wallet-ledger-entry.js';
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  type WagerTransactionProcessedData,
} from '../outbox/integration-events.js';
import type {
  PersistedWagerResult,
  WagerPersistencePort,
  WagerTransactionSession,
} from './wager-processing.port.js';
import { WagerIdentityAlreadyExistsError } from './wager-processing.port.js';
import type { InboxMessageRegistration } from './wager-processing.port.js';
import {
  InboxMessagePayloadConflictError,
} from '../messaging/inbox-errors.js';

export type ProcessableWagerKind =
  | WagerTransactionKind.Bet
  | WagerTransactionKind.Win
  | WagerTransactionKind.Loss
  | WagerTransactionKind.Refund
  | WagerTransactionKind.Rollback;

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
  readonly referenceExternalTransactionId?: string;
}

export interface ProcessWagerResult {
  readonly transactionId: string;
  readonly status:
    | WagerTransactionStatus.Processed
    | WagerTransactionStatus.Rejected
    | WagerTransactionStatus.PendingReference;
  readonly balance: Money | null;
  readonly idempotentReplay: boolean;
  readonly failureCode?: string;
}

export interface InboxMessageIdentity {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
}

type InternalWagerResult =
  | { readonly kind: 'RESULT'; readonly result: ProcessWagerResult }
  | { readonly kind: 'DUPLICATE_INBOX_MESSAGE' };

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
    const outcome = await this.executeInternal(command);
    if (outcome.kind === 'DUPLICATE_INBOX_MESSAGE') {
      throw new WagerPersistenceInvariantError(
        'Uma execução HTTP não pode ser deduplicada por inbox.',
      );
    }
    return outcome.result;
  }

  async executeFromInbox(
    command: ProcessWagerCommand,
    identity: InboxMessageIdentity,
  ): Promise<{ readonly duplicate: boolean; readonly result?: ProcessWagerResult }> {
    const outcome = await this.executeInternal(command, identity);
    return outcome.kind === 'DUPLICATE_INBOX_MESSAGE'
      ? { duplicate: true }
      : { duplicate: false, result: outcome.result };
  }

  async recordTerminalInboxMessage(identity: InboxMessageIdentity): Promise<void> {
    await this.completeInboxOutsideWager(identity);
  }

  private async executeInternal(
    command: ProcessWagerCommand,
    inboxIdentity?: InboxMessageIdentity,
  ): Promise<InternalWagerResult> {
    const createdAt = new Date();
    const inboxMessage = inboxIdentity
      ? InboxMessage.receive(inboxIdentity)
      : undefined;
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
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt,
    });

    try {
      return await this.persistence.transaction(async (session) => {
        if (inboxMessage) {
          const registration = await session.registerInboxMessage(inboxMessage);
          this.assertInboxRegistration(registration);
          if (registration === 'DUPLICATE') {
            return { kind: 'DUPLICATE_INBOX_MESSAGE' };
          }
        }
        const complete = async (
          result: ProcessWagerResult,
        ): Promise<InternalWagerResult> => {
          if (inboxMessage) {
            inboxMessage.markProcessed(new Date());
            await session.markInboxMessageProcessed(inboxMessage);
          }
          return { kind: 'RESULT', result };
        };

        const existingBeforeLock = await session.findByIdempotencyKey(
          command.idempotencyKey,
        );
        if (existingBeforeLock) {
          return complete(this.replay(existingBeforeLock, command.payloadHash));
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
          return complete(this.replay(existingAfterLock, command.payloadHash));
        }

        if (wallet.currency !== command.money.currency) {
          throw new WagerCurrencyMismatchError(wallet.currency, command.money.currency);
        }

        await session.insertPendingTransaction(transaction);
        const occurredAt = new Date();
        let reference: WagerTransaction | undefined;

        if (transaction.referenceExternalTransactionId !== undefined) {
          if (
            transaction.referenceExternalTransactionId ===
            transaction.externalTransactionId
          ) {
            return complete(await this.reject(
              session,
              transaction,
              wallet,
              occurredAt,
              'INVALID_REFERENCE',
            ));
          }

          const candidate = await session.findReference(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          );
          if (
            !candidate ||
            candidate.status === WagerTransactionStatus.Pending ||
            candidate.status === WagerTransactionStatus.PendingReference
          ) {
            return complete(await this.deferUntilReferenceExists(
              session,
              transaction,
              occurredAt,
            ));
          }
          reference = candidate;
        }

        return complete(await this.applyResolvedTransaction(
          session,
          transaction,
          wallet,
          reference,
          occurredAt,
          1,
        ));
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

      const result = this.replay(existing, command.payloadHash);
      if (inboxIdentity) {
        await this.completeInboxOutsideWager(inboxIdentity);
      }
      return { kind: 'RESULT', result };
    }
  }

  async executeDuePendingReferences(
    limit = 10,
  ): Promise<{
    readonly claimed: number;
    readonly processed: number;
    readonly rejected: number;
    readonly retried: number;
  }> {
    return this.persistence.transaction(async (session) => {
      const workItems = await session.findDuePendingReferences(limit);
      let processed = 0;
      let rejected = 0;
      let retried = 0;

      for (const workItem of workItems) {
        const { transaction, retry, databaseNow } = workItem;
        const externalReferenceId = transaction.referenceExternalTransactionId;
        if (!externalReferenceId) {
          throw new WagerPersistenceInvariantError(
            'Uma transação PENDING_REFERENCE precisa manter a referência externa.',
          );
        }

        if (retry.isExpired(databaseNow)) {
          const wallet = await session.findWalletForUpdate(transaction.walletId);
          if (!wallet) {
            throw new WagerWalletNotFoundError(transaction.walletId);
          }
          await this.reject(
            session,
            transaction,
            wallet,
            databaseNow,
            'REFERENCE_EXPIRED',
            2,
          );
          rejected += 1;
          continue;
        }

        const candidate = await session.findReference(
          transaction.providerId,
          externalReferenceId,
        );
        if (
          !candidate ||
          candidate.status === WagerTransactionStatus.Pending ||
          candidate.status === WagerTransactionStatus.PendingReference
        ) {
          const schedule = retry.scheduleRetry(databaseNow);
          await session.schedulePendingReferenceRetry(
            transaction.id,
            schedule.attempts,
            schedule.delaySeconds,
          );
          retried += 1;
          continue;
        }

        const wallet = await session.findWalletForUpdate(transaction.walletId);
        if (!wallet) {
          throw new WagerWalletNotFoundError(transaction.walletId);
        }
        if (wallet.playerId !== transaction.playerId) {
          throw new WagerWalletOwnerMismatchError();
        }
        if (wallet.currency !== transaction.money.currency) {
          throw new WagerCurrencyMismatchError(wallet.currency, transaction.money.currency);
        }

        const result = await this.applyResolvedTransaction(
          session,
          transaction,
          wallet,
          candidate,
          databaseNow,
          2,
        );
        if (result.status === WagerTransactionStatus.Processed) {
          processed += 1;
        } else {
          rejected += 1;
        }
      }

      return { claimed: workItems.length, processed, rejected, retried };
    });
  }

  private async applyResolvedTransaction(
    session: WagerTransactionSession,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    occurredAt: Date,
    processedSequence: number,
  ): Promise<ProcessWagerResult> {
    let direction: LedgerDirection | undefined;
    try {
      direction = transaction.ledgerDirectionFor(reference);
    } catch (error) {
      if (!(error instanceof InvalidWagerTransactionError)) {
        throw error;
      }
      return this.reject(
        session,
        transaction,
        wallet,
        occurredAt,
        'INVALID_REFERENCE',
        processedSequence,
      );
    }

    if (
      reference &&
      (transaction.kind === WagerTransactionKind.Refund ||
        transaction.kind === WagerTransactionKind.Rollback) &&
      await session.hasProcessedReversal(reference.id, transaction.kind)
    ) {
      return this.reject(
        session,
        transaction,
        wallet,
        occurredAt,
        'ALREADY_REVERSED',
        processedSequence,
      );
    }

    let entry: WalletLedgerEntry | undefined;
    try {
      if (transaction.affectsBalance()) {
        if (direction === LedgerDirection.Debit) {
          entry = wallet.debit({
            ledgerEntryId: randomUUID(),
            transactionId: transaction.id,
            money: transaction.money,
            occurredAt,
          });
        } else if (direction === LedgerDirection.Credit) {
          entry = wallet.credit({
            ledgerEntryId: randomUUID(),
            transactionId: transaction.id,
            money: transaction.money,
            occurredAt,
          });
        }
      }
    } catch (error) {
      if (!(error instanceof InsufficientWalletBalanceError)) {
        throw error;
      }
      if (transaction.kind === WagerTransactionKind.Bet) {
        return this.reject(
          session,
          transaction,
          wallet,
          occurredAt,
          'INSUFFICIENT_FUNDS',
          processedSequence,
        );
      }
      if (
        transaction.kind === WagerTransactionKind.Refund ||
        transaction.kind === WagerTransactionKind.Rollback
      ) {
        return this.reject(
          session,
          transaction,
          wallet,
          occurredAt,
          'REVERSAL_INSUFFICIENT_FUNDS',
          processedSequence,
        );
      }
      throw error;
    }

    if (entry) {
      await session.saveWallet(wallet);
      await session.insertLedgerEntry(entry);
    }
    transaction.markProcessed(reference?.id, occurredAt);
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
      sequenceNumber: processedSequence,
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
        sequenceNumber: processedSequence + 1,
        event: balanceChangedEvent.toJSON(),
      });
    }

    return {
      transactionId: transaction.id,
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance,
      idempotentReplay: false,
    };
  }

  private assertInboxRegistration(registration: InboxMessageRegistration): void {
    if (registration === 'PAYLOAD_CONFLICT') {
      throw new InboxMessagePayloadConflictError();
    }
    if (registration === 'INCOMPLETE') {
      throw new WagerPersistenceInvariantError(
        'A inbox contém uma mensagem sem commit de processamento anterior.',
      );
    }
  }

  private async completeInboxOutsideWager(
    identity: InboxMessageIdentity,
  ): Promise<void> {
    const message = InboxMessage.receive(identity);
    await this.persistence.transaction(async (session) => {
      const registration = await session.registerInboxMessage(message);
      this.assertInboxRegistration(registration);
      if (registration === 'DUPLICATE') {
        return;
      }
      message.markProcessed(new Date());
      await session.markInboxMessageProcessed(message);
    });
  }

  private async reject(
    session: WagerTransactionSession,
    transaction: WagerTransaction,
    wallet: Wallet,
    occurredAt: Date,
    failureCode: string,
    sequenceNumber = 1,
  ): Promise<ProcessWagerResult> {
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
      sequenceNumber,
      event: rejectedEvent.toJSON(),
    });
    return {
      transactionId: transaction.id,
      status: WagerTransactionStatus.Rejected,
      balance: wallet.balance,
      idempotentReplay: false,
      failureCode,
    };
  }

  private async deferUntilReferenceExists(
    session: WagerTransactionSession,
    transaction: WagerTransaction,
    occurredAt: Date,
  ): Promise<ProcessWagerResult> {
    const referenceExternalTransactionId =
      transaction.referenceExternalTransactionId;
    if (!referenceExternalTransactionId) {
      throw new WagerPersistenceInvariantError(
        'Uma operação sem referência externa não pode aguardar uma referência.',
      );
    }

    transaction.markPendingReference();
    await session.savePendingReference(transaction);
    const pendingEvent = WagerTransactionPendingReference.create({
      eventId: randomUUID(),
      aggregateId: transaction.id,
      correlationId: transaction.id,
      occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        referenceExternalTransactionId,
      },
    });
    await session.insertOutboxMessage({
      transactionId: transaction.id,
      sequenceNumber: 1,
      event: pendingEvent.toJSON(),
    });
    return {
      transactionId: transaction.id,
      status: WagerTransactionStatus.PendingReference,
      balance: null,
      idempotentReplay: false,
    };
  }

  private replay(
    existing: PersistedWagerResult,
    payloadHash: string,
  ): ProcessWagerResult {
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError();
    }
    if (existing.status === WagerTransactionStatus.PendingReference) {
      return {
        transactionId: existing.transactionId,
        status: WagerTransactionStatus.PendingReference,
        balance: null,
        idempotentReplay: true,
      };
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
