/**
 * Esta página define as consultas de leitura disponíveis para carteiras e ledger.
 * Assinatura: Leonardo de Souza da Luz
 */
import type { MoneyProps } from '../../domain/money/money.js';

export interface WalletReadModel {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export interface WalletLedgerPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface WalletLedgerRow {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: string;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly createdAt: string;
  readonly cursorCreatedAt: string;
}

export interface WalletLedgerSlice {
  readonly rows: readonly WalletLedgerRow[];
  readonly hasMore: boolean;
}

export interface WalletReadPort {
  findWalletById(walletId: string): Promise<WalletReadModel | null>;
  findLedgerRows(
    walletId: string,
    before: WalletLedgerPosition | undefined,
    limit: number,
  ): Promise<WalletLedgerSlice>;
}
