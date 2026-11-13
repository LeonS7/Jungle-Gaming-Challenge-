/**
 * Esta página calcula um hash estável dos dados de negócio de wagering.
 * Assinatura: Leonardo de Souza da Luz
 */
import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../domain/money/money.js';
import type { ProcessableWagerKind } from './process-wager.js';

export interface WagerPayloadForHash {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: ProcessableWagerKind;
  readonly money: MoneyProps;
}

/** Serializa as chaves em ordem fixa e exclui cabeçalhos e metadados HTTP. */
export function hashWagerPayload(payload: WagerPayloadForHash): string {
  const canonicalPayload = JSON.stringify({
    externalTransactionId: payload.externalTransactionId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    playerId: payload.playerId,
    providerId: payload.providerId,
    roundId: payload.roundId,
    walletId: payload.walletId,
  });

  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}
