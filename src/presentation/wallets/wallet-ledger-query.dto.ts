/**
 * Esta página valida cursor e limite da consulta paginada do ledger.
 * Assinatura: Leonardo de Souza da Luz
 */
export class InvalidWalletLedgerQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletLedgerQueryError';
  }
}

export interface WalletLedgerQuery {
  readonly cursor?: string;
  readonly limit: number;
}

export function parseWalletLedgerQuery(
  cursorInput: unknown,
  limitInput: unknown,
): WalletLedgerQuery {
  let cursor: string | undefined;
  if (cursorInput !== undefined) {
    if (typeof cursorInput !== 'string' || cursorInput.length === 0) {
      throw new InvalidWalletLedgerQueryError('cursor deve ser uma string não vazia.');
    }
    cursor = cursorInput;
  }

  if (limitInput === undefined) {
    return { cursor, limit: 50 };
  }
  if (typeof limitInput !== 'string' || !/^\d+$/.test(limitInput)) {
    throw new InvalidWalletLedgerQueryError('limit deve ser um número inteiro.');
  }

  const limit = Number(limitInput);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidWalletLedgerQueryError('limit deve estar entre 1 e 100.');
  }

  return { cursor, limit };
}
