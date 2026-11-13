/**
 * Esta página define a persistência atômica da abertura de uma carteira.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Wallet } from '../../domain/wallet/wallet.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { OutboxMessageToAppend } from '../outbox/integration-events.js';

export interface WalletOpeningRecords {
  readonly transaction: WagerTransaction;
  readonly ledgerEntry: WalletLedgerEntry;
  readonly outboxMessages: readonly OutboxMessageToAppend[];
}

export interface OpenWalletPersistencePort {
  create(wallet: Wallet, opening?: WalletOpeningRecords): Promise<void>;
}

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super('Já existe uma carteira para este jogador e esta moeda.');
    this.name = 'WalletAlreadyExistsError';
  }
}

export class WalletPersistenceInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletPersistenceInvariantError';
  }
}
