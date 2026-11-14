/** Esta página verifica regras de preparação e retry das ferramentas de laboratório. Assinatura: Leonardo de Souza da Luz */
import { describe, expect, test } from 'bun:test';
import type { WagerTransactionView } from '../src/api/wagering-api';
import {
  canReverseTransaction,
  clearRetryableRequest,
  createReversalPayload,
  loadRetryableRequest,
  saveRetryableRequest,
  type RetryableWagerRequest,
} from '../src/features/laboratory/laboratory-operations';

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
}

function createTransaction(overrides: Partial<WagerTransactionView> = {}): WagerTransactionView {
  return {
    transactionId: 'id-interno',
    providerId: 'provedor-real',
    externalTransactionId: 'bet-original-1',
    playerId: 'jogador-1',
    walletId: 'carteira-1',
    roundId: 'rodada-1',
    gameId: 'jogo-1',
    kind: 'BET',
    status: 'PROCESSED',
    money: { amount: '80.00', currency: 'BRL' },
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    failureCode: null,
    balance: { amount: '20.00', currency: 'BRL' },
    createdAt: '2026-11-14T12:00:00.000Z',
    processedAt: '2026-11-14T12:00:00.000Z',
    ...overrides,
  };
}

describe('operações do laboratório', () => {
  test('prepara estorno com referência e valor exatos da BET retornada pela API', () => {
    const transaction = createTransaction();

    expect(canReverseTransaction(transaction, 'REFUND')).toBe(true);
    expect(createReversalPayload(transaction, 'REFUND', 'refund-novo')).toEqual({
      providerId: 'provedor-real',
      externalTransactionId: 'refund-novo',
      playerId: 'jogador-1',
      walletId: 'carteira-1',
      roundId: 'rodada-1',
      gameId: 'jogo-1',
      kind: 'REFUND',
      money: { amount: '80.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-original-1',
    });
  });

  test('não oferece referências pendentes nem tipos incompatíveis para reversão', () => {
    expect(canReverseTransaction(createTransaction({ status: 'PENDING_REFERENCE' }), 'REFUND')).toBe(false);
    expect(canReverseTransaction(createTransaction({ kind: 'WIN' }), 'REFUND')).toBe(false);
    expect(canReverseTransaction(createTransaction({ kind: 'REFUND' }), 'ROLLBACK')).toBe(true);
  });

  test('recupera após navegação ou reinício o mesmo payload decimal e chave para retry', () => {
    const storage = createStorage();
    const original: RetryableWagerRequest = {
      payload: createReversalPayload(createTransaction(), 'REFUND', 'refund-novo'),
      key: 'chave-original-1',
    };

    saveRetryableRequest(storage, original);
    expect(loadRetryableRequest(storage)).toEqual(original);
    expect(loadRetryableRequest(storage)?.payload.money.amount).toBe('80.00');
    clearRetryableRequest(storage);
    expect(loadRetryableRequest(storage)).toBeNull();
  });

  test('descarta com segurança uma solicitação local corrompida', () => {
    const storage = createStorage();
    storage.setItem('jungle-gaming:pending-wager-retry:v1', '{invalido');

    expect(loadRetryableRequest(storage)).toBeNull();
    expect(storage.length).toBe(0);
  });
});
