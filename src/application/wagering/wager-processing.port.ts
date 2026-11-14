/**
 * Esta página define a porta transacional para processar operações de wagering.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Money } from '../../domain/money/money.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { PendingReferenceRetry } from '../../domain/wagering/pending-reference-retry.js';
import type { OutboxMessageToAppend } from '../outbox/integration-events.js';

export interface PersistedWagerResult {
  readonly transactionId: string;
  readonly payloadHash: string;
  readonly status: WagerTransactionStatus;
  readonly balance: Money | null;
  readonly failureCode: string | null;
}

export type InboxMessageRegistration =
  | 'REGISTERED'
  | 'DUPLICATE'
  | 'PAYLOAD_CONFLICT'
  | 'INCOMPLETE';

export interface PendingReferenceWorkItem {
  readonly transaction: WagerTransaction;
  readonly retry: PendingReferenceRetry;
  readonly databaseNow: Date;
}

export interface WagerTransactionSession {
  registerInboxMessage(message: InboxMessage): Promise<InboxMessageRegistration>;
  markInboxMessageProcessed(message: InboxMessage): Promise<void>;
  findByIdempotencyKey(key: string): Promise<PersistedWagerResult | null>;
  findWalletForUpdate(walletId: string): Promise<Wallet | null>;
  findReference(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  hasProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  ): Promise<boolean>;
  insertPendingTransaction(transaction: WagerTransaction): Promise<void>;
  savePendingReference(transaction: WagerTransaction): Promise<void>;
  findDuePendingReferences(limit: number): Promise<readonly PendingReferenceWorkItem[]>;
  schedulePendingReferenceRetry(
    transactionId: string,
    attempts: number,
    delaySeconds: number,
  ): Promise<void>;
  saveWallet(wallet: Wallet): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  insertOutboxMessage(message: OutboxMessageToAppend): Promise<void>;
  saveTransactionResult(
    transaction: WagerTransaction,
    observedBalance: Money,
  ): Promise<void>;
}

export interface WagerPersistencePort {
  transaction<T>(operation: (session: WagerTransactionSession) => Promise<T>): Promise<T>;
  findByIdempotencyKey(key: string): Promise<PersistedWagerResult | null>;
}

export type WagerIdentityConflictKind = 'idempotency-key' | 'provider-transaction';

/** Sinaliza colisão em uma constraint única conhecida do PostgreSQL. */
export class WagerIdentityAlreadyExistsError extends Error {
  constructor(public readonly kind: WagerIdentityConflictKind) {
    super(
      kind === 'idempotency-key'
        ? 'A chave de idempotência já está associada a uma transação.'
        : 'O provedor já enviou uma transação com esse identificador externo.',
    );
    this.name = 'WagerIdentityAlreadyExistsError';
  }
}
