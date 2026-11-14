/** Este módulo prepara reversões usando apenas transações persistidas pela API e guarda a solicitação incerta para retry idêntico. Assinatura: Leonardo de Souza da Luz */
import type { WagerRequest, WagerTransactionView } from '../../api/wagering-api';

export type ReversalKind = 'REFUND' | 'ROLLBACK';

export interface RetryableWagerRequest {
  readonly payload: WagerRequest;
  readonly key: string;
}

const RETRY_STORAGE_KEY = 'jungle-gaming:pending-wager-retry:v1';

function isWagerKind(value: unknown): value is WagerRequest['kind'] {
  return value === 'BET' || value === 'WIN' || value === 'LOSS' || value === 'REFUND' || value === 'ROLLBACK';
}

function isRetryableRequest(value: unknown): value is RetryableWagerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RetryableWagerRequest>;
  const payload = candidate.payload;
  return typeof candidate.key === 'string' && candidate.key.length > 0 &&
    typeof payload === 'object' && payload !== null &&
    typeof payload.providerId === 'string' &&
    typeof payload.externalTransactionId === 'string' &&
    typeof payload.playerId === 'string' &&
    typeof payload.walletId === 'string' &&
    typeof payload.roundId === 'string' &&
    typeof payload.gameId === 'string' && isWagerKind(payload.kind) &&
    typeof payload.money === 'object' && payload.money !== null &&
    typeof payload.money.amount === 'string' &&
    typeof payload.money.currency === 'string' &&
    (payload.referenceExternalTransactionId === undefined ||
      typeof payload.referenceExternalTransactionId === 'string');
}

export function canReverseTransaction(
  transaction: WagerTransactionView,
  kind: ReversalKind,
): boolean {
  if (transaction.status !== 'PROCESSED') return false;
  if (kind === 'REFUND') return transaction.kind === 'BET';
  return transaction.kind === 'BET' || transaction.kind === 'WIN' || transaction.kind === 'REFUND';
}

export function createReversalPayload(
  transaction: WagerTransactionView,
  kind: ReversalKind,
  externalTransactionId: string,
): WagerRequest {
  if (!canReverseTransaction(transaction, kind)) {
    throw new Error('A transação selecionada não pode ser usada nesta reversão.');
  }
  return {
    providerId: transaction.providerId,
    externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind,
    money: {
      amount: transaction.money.amount,
      currency: transaction.money.currency,
    },
    referenceExternalTransactionId: transaction.externalTransactionId,
  };
}

export function saveRetryableRequest(
  storage: Pick<Storage, 'setItem'>,
  request: RetryableWagerRequest,
): void {
  storage.setItem(RETRY_STORAGE_KEY, JSON.stringify(request));
}

export function loadRetryableRequest(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
): RetryableWagerRequest | null {
  const saved = storage.getItem(RETRY_STORAGE_KEY);
  if (!saved) return null;
  try {
    const parsed: unknown = JSON.parse(saved);
    if (isRetryableRequest(parsed)) return parsed;
  } catch {
    // Um valor local inválido é descartado; a API continua sendo a fonte da verdade.
  }
  storage.removeItem(RETRY_STORAGE_KEY);
  return null;
}

export function clearRetryableRequest(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(RETRY_STORAGE_KEY);
}
