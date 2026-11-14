/**
 * Esta página mantém os contratos HTTP usados pelas telas de carteira e wagering.
 * Valores monetários trafegam como strings decimais; a API continua responsável
 * pelas regras, pela idempotência e por persistir as operações.
 * Assinatura: Leonardo de Souza da Luz
 */
const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || '/api';
type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MoneyView {
  readonly amount: string;
  readonly currency: string;
}

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyView;
  readonly version: number;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: string;
  readonly money: MoneyView;
  readonly balanceBefore: MoneyView;
  readonly balanceAfter: MoneyView;
  readonly createdAt: string;
}

export interface LedgerPageView {
  readonly items: readonly LedgerEntryView[];
  readonly nextCursor: string | null;
}

export interface ReconciliationView {
  readonly walletId: string;
  readonly storedBalance: MoneyView;
  readonly calculatedBalance: MoneyView;
  readonly difference: MoneyView;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface WagerRequest {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: MoneyView;
  readonly referenceExternalTransactionId?: string;
}

export interface WagerSubmissionView {
  readonly transactionId: string;
  readonly status: string;
  readonly balance?: MoneyView;
  readonly idempotentReplay: boolean;
  readonly failureCode?: string;
}

export interface WagerTransactionView {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly status: string;
  readonly money: MoneyView;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly failureCode: string | null;
  readonly balance: MoneyView | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function readError(response: Response): Promise<ApiRequestError> {
  let message = `A API respondeu com o código ${response.status}.`;
  let code: string | null = null;
  try {
    const body = await response.json() as { message?: unknown; code?: unknown };
    if (typeof body.message === 'string') {
      message = body.message;
    } else if (Array.isArray(body.message)) {
      message = body.message.filter((item): item is string => typeof item === 'string').join(' ');
    }
    if (typeof body.code === 'string') {
      code = body.code;
    }
  } catch {
    // A mensagem padrão conserva o status quando a resposta não contém JSON.
  }
  return new ApiRequestError(message, response.status, code);
}

export function createWageringApi(fetcher: ApiFetch = fetch) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(API_BASE_URL + path, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw await readError(response);
    }
    return await response.json() as T;
  }

  return {
    createWallet(playerId: string, initialBalance: MoneyView): Promise<WalletView> {
      return request('/wallets', {
        method: 'POST',
        body: JSON.stringify({ playerId, initialBalance }),
      });
    },
    getWallet(walletId: string): Promise<WalletView> {
      return request(`/wallets/${encodeURIComponent(walletId)}`);
    },
    getWalletLedger(walletId: string, cursor?: string): Promise<LedgerPageView> {
      const query = new URLSearchParams({ limit: '20' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      return request(`/wallets/${encodeURIComponent(walletId)}/ledger?${query.toString()}`);
    },
    reconcileWallet(walletId: string): Promise<ReconciliationView> {
      return request(`/wallets/${encodeURIComponent(walletId)}/reconciliation`, {
        method: 'POST',
      });
    },
    submitWager(payload: WagerRequest, idempotencyKey: string): Promise<WagerSubmissionView> {
      return request('/wagering/transactions', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(payload),
      });
    },
    getTransaction(transactionId: string): Promise<WagerTransactionView> {
      return request(`/wagering/transactions/${encodeURIComponent(transactionId)}`);
    },
    getProviderTransaction(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
      return request(
        `/providers/${encodeURIComponent(providerId)}/wagering/transactions/${encodeURIComponent(externalTransactionId)}`,
      );
    },
  };
}

export const wageringApi = createWageringApi();
