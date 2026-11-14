/** Este módulo prepara reversões usando apenas transações persistidas pela API e guarda a solicitação incerta para retry idêntico. Assinatura: Leonardo de Souza da Luz */
import type {
  LedgerEntryView,
  ReconciliationView,
  WalletView,
  WagerRequest,
  WagerTransactionView,
} from '../../api/wagering-api';

export type ReversalKind = 'REFUND' | 'ROLLBACK';

export interface RetryableWagerRequest {
  readonly payload: WagerRequest;
  readonly key: string;
}

export interface ConcurrencyAcceptanceAudit {
  readonly twoBetsAreEighty: boolean;
  readonly oneProcessed: boolean;
  readonly oneRejectedForInsufficientFunds: boolean;
  readonly oneDebitOfEighty: boolean;
  readonly finalBalanceIsTwenty: boolean;
  readonly reconciled: boolean;
  readonly passed: boolean;
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
  let saved: string | null;
  try {
    saved = storage.getItem(RETRY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!saved) return null;
  try {
    const parsed: unknown = JSON.parse(saved);
    if (isRetryableRequest(parsed)) return parsed;
  } catch {
    // Um valor local inválido é descartado; a API continua sendo a fonte da verdade.
  }
  try {
    storage.removeItem(RETRY_STORAGE_KEY);
  } catch {
    // O valor inválido não é usado na operação mesmo se não puder ser removido.
  }
  return null;
}

export function clearRetryableRequest(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(RETRY_STORAGE_KEY);
}

export function evaluateConcurrencyAcceptance(
  transactions: readonly WagerTransactionView[],
  ledger: readonly LedgerEntryView[],
  wallet: WalletView,
  reconciliation: ReconciliationView,
): ConcurrencyAcceptanceAudit {
  const debitEntries = ledger.filter((entry) => entry.direction === 'DEBIT');
  const twoBetsAreEighty = transactions.length === 2 && transactions.every(
    (transaction) => transaction.kind === 'BET' && transaction.money.amount === '80.00' && transaction.money.currency === 'BRL',
  );
  const oneProcessed = transactions.length === 2 && transactions.filter(
    (transaction) => transaction.status === 'PROCESSED',
  ).length === 1;
  const oneRejectedForInsufficientFunds = transactions.length === 2 && transactions.filter(
    (transaction) => transaction.status === 'REJECTED' && transaction.failureCode === 'INSUFFICIENT_FUNDS',
  ).length === 1;
  const oneDebitOfEighty = debitEntries.length === 1 && debitEntries[0]?.money.amount === '80.00' && debitEntries[0].money.currency === 'BRL';
  const finalBalanceIsTwenty = wallet.balance.amount === '20.00' && wallet.balance.currency === 'BRL';
  const reconciled = reconciliation.consistent &&
    reconciliation.storedBalance.amount === '20.00' &&
    reconciliation.storedBalance.currency === 'BRL' &&
    reconciliation.calculatedBalance.amount === '20.00' &&
    reconciliation.calculatedBalance.currency === 'BRL' &&
    reconciliation.checkedEntries === ledger.length;

  return {
    twoBetsAreEighty,
    oneProcessed,
    oneRejectedForInsufficientFunds,
    oneDebitOfEighty,
    finalBalanceIsTwenty,
    reconciled,
    passed: twoBetsAreEighty && oneProcessed && oneRejectedForInsufficientFunds && oneDebitOfEighty && finalBalanceIsTwenty && reconciled,
  };
}
