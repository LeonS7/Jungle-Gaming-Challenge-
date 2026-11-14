/**
 * Esta página define projeções de leitura para transações de wagering.
 * Assinatura: Leonardo de Souza da Luz
 */
import type { MoneyProps } from '../../domain/money/money.js';

export interface WagerTransactionReadModel {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: string;
  readonly failureCode: string | null;
  readonly balance: MoneyProps | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
}

export interface WagerTransactionPosition {
  readonly createdAt: string;
  readonly transactionId: string;
}

export interface WagerTransactionSlice {
  readonly rows: readonly WagerTransactionReadModel[];
  readonly hasMore: boolean;
  readonly lastPosition: WagerTransactionPosition | null;
}

export interface WagerReadPort {
  findById(transactionId: string): Promise<WagerTransactionReadModel | null>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionReadModel | null>;
  findByWalletId(
    walletId: string,
    before: WagerTransactionPosition | undefined,
    limit: number,
  ): Promise<WagerTransactionSlice>;
}
