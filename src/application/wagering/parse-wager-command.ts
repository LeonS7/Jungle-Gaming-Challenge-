/**
 * Esta página valida dados de wagering e monta o comando da aplicação.
 * Assinatura: Leonardo de Souza da Luz
 */
import { InvalidMoneyError, Money } from '../../domain/money/money.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';
import { hashWagerPayload } from './hash-wager-payload.js';
import type { ProcessableWagerKind, ProcessWagerCommand } from './process-wager.js';

const REQUEST_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'referenceExternalTransactionId',
  'money',
] as const;

export class InvalidWagerRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerRequestError';
  }
}

export class UnsupportedWagerKindError extends Error {
  constructor() {
    super('Este tipo de transação ainda não é suportado.');
    this.name = 'UnsupportedWagerKindError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new InvalidWagerRequestError(`${field} deve ser um objeto JSON.`);
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
    throw new InvalidWagerRequestError(`O campo ${parent}.${unknownField} não é permitido.`);
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidWagerRequestError(`${field} deve ser uma string não vazia.`);
  }
  return value;
}

function requireWalletId(value: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new InvalidWagerRequestError('walletId deve ser um UUID válido.');
  }
  return value;
}

export function parseWagerCommand(
  body: unknown,
  idempotencyKey: unknown,
  idempotencyKeyField = 'chave de idempotência',
): ProcessWagerCommand {
  const request = requireObject(body, 'body');
  rejectUnknownFields(request, REQUEST_FIELDS, 'body');

  const providerId = requireText(request.providerId, 'providerId');
  const externalTransactionId = requireText(
    request.externalTransactionId,
    'externalTransactionId',
  );
  const playerId = requireText(request.playerId, 'playerId');
  const walletId = requireWalletId(requireText(request.walletId, 'walletId'));
  const roundId = requireText(request.roundId, 'roundId');
  const gameId = requireText(request.gameId, 'gameId');
  const kind = requireText(request.kind, 'kind');
  if (
    kind !== WagerTransactionKind.Bet &&
    kind !== WagerTransactionKind.Win &&
    kind !== WagerTransactionKind.Loss &&
    kind !== WagerTransactionKind.Refund &&
    kind !== WagerTransactionKind.Rollback
  ) {
    throw new UnsupportedWagerKindError();
  }
  const wagerKind: ProcessableWagerKind = kind;
  const referenceExternalTransactionId =
    request.referenceExternalTransactionId === undefined
      ? undefined
      : requireText(
          request.referenceExternalTransactionId,
          'referenceExternalTransactionId',
        );
  if (
    (wagerKind === WagerTransactionKind.Refund ||
      wagerKind === WagerTransactionKind.Rollback) &&
    referenceExternalTransactionId === undefined
  ) {
    throw new InvalidWagerRequestError(
      `Transações ${wagerKind} exigem referenceExternalTransactionId.`,
    );
  }

  const moneyRequest = requireObject(request.money, 'money');
  rejectUnknownFields(moneyRequest, ['amount', 'currency'], 'money');
  const amount = requireText(moneyRequest.amount, 'money.amount');
  const currency = requireText(moneyRequest.currency, 'money.currency');
  if (!/^\d{1,28}\.\d{2}$/.test(amount)) {
    throw new InvalidWagerRequestError(
      'money.amount deve ser uma string decimal positiva com duas casas e no máximo 28 dígitos inteiros.',
    );
  }

  let money: Money;
  try {
    money = Money.from({ amount, currency });
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new InvalidWagerRequestError(error.message);
    }
    throw error;
  }
  if (!money.isPositive()) {
    throw new InvalidWagerRequestError('money.amount deve ser maior que zero.');
  }

  const key = requireText(idempotencyKey, idempotencyKeyField);
  const moneyProps = money.toJSON();
  const payloadHash = hashWagerPayload({
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind: wagerKind,
    money: moneyProps,
    ...(referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId }
      : {}),
  });

  return {
    providerId,
    externalTransactionId,
    idempotencyKey: key,
    payloadHash,
    playerId,
    walletId,
    roundId,
    gameId,
    kind: wagerKind,
    money,
    ...(referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId }
      : {}),
  };
}
