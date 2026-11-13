/**
 * Esta página define a porta transacional para processar operações de wagering.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { OutboxMessageToAppend } from '../outbox/integration-events.js';

export interface PersistedWagerResult {
  readonly transactionId: string;
  readonly payloadHash: string;
  readonly status: WagerTransactionStatus;
  readonly balance: Money | null;
  readonly failureCode: string | null;
}

export interface WagerTransactionSession {
  findByIdempotencyKey(key: string): Promise<PersistedWagerResult | null>;
  findWalletForUpdate(walletId: string): Promise<Wallet | null>;
  insertPendingTransaction(transaction: WagerTransaction): Promise<void>;
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
