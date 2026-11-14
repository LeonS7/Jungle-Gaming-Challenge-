/**
 * Esta página valida cursor e limite da consulta do histórico da carteira.
 * Assinatura: Leonardo de Souza da Luz
 */
export class InvalidWalletTransactionsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletTransactionsQueryError';
  }
}

export interface WalletTransactionsQuery {
  readonly cursor?: string;
  readonly limit: number;
}

export function parseWalletTransactionsQuery(
  cursorInput: unknown,
  limitInput: unknown,
): WalletTransactionsQuery {
  let cursor: string | undefined;
  if (cursorInput !== undefined) {
    if (typeof cursorInput !== 'string' || cursorInput.length === 0) {
      throw new InvalidWalletTransactionsQueryError(
        'cursor deve ser uma string não vazia.',
      );
    }
    cursor = cursorInput;
  }

  if (limitInput === undefined) {
    return { cursor, limit: 50 };
  }
  if (typeof limitInput !== 'string' || !/^\d+$/.test(limitInput)) {
    throw new InvalidWalletTransactionsQueryError('limit deve ser um número inteiro.');
  }

  const limit = Number(limitInput);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidWalletTransactionsQueryError(
      'limit deve estar entre 1 e 100.',
    );
  }

  return { cursor, limit };
}
