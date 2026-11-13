/**
 * Esta página valida a criação HTTP de carteira e o saldo inicial decimal.
 * Assinatura: Leonardo de Souza da Luz
 */
import { InvalidMoneyError, Money } from '../../domain/money/money.js';
import type { OpenWalletCommand } from '../../application/wallets/open-wallet.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new InvalidOpenWalletRequestError(`${field} deve ser um objeto JSON.`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidOpenWalletRequestError(`${field} deve ser uma string não vazia.`);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  parent: string,
): void {
  const unknownField = Object.keys(value).find((field) => !allowedFields.includes(field));
  if (unknownField) {
    throw new InvalidOpenWalletRequestError(`O campo ${parent}.${unknownField} não é permitido.`);
  }
}

export class InvalidOpenWalletRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOpenWalletRequestError';
  }
}

export function parseOpenWalletRequest(body: unknown): OpenWalletCommand {
  const request = requireObject(body, 'body');
  rejectUnknownFields(request, ['playerId', 'initialBalance'], 'body');
  const playerId = requireText(request.playerId, 'playerId');
  const balanceRequest = requireObject(request.initialBalance, 'initialBalance');
  rejectUnknownFields(balanceRequest, ['amount', 'currency'], 'initialBalance');

  const amount = requireText(balanceRequest.amount, 'initialBalance.amount');
  const currency = requireText(balanceRequest.currency, 'initialBalance.currency');
  if (!/^\d{1,28}\.\d{2}$/.test(amount)) {
    throw new InvalidOpenWalletRequestError(
      'initialBalance.amount deve ser uma string decimal não negativa com duas casas e no máximo 28 dígitos inteiros.',
    );
  }

  try {
    return {
      playerId,
      initialBalance: Money.from({ amount, currency }),
    };
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new InvalidOpenWalletRequestError(error.message);
    }
    throw error;
  }
}
