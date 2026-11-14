/** Esta página verifica regras de preparação e retry das ferramentas de laboratório. Assinatura: Leonardo de Souza da Luz */
import { describe, expect, test } from 'bun:test';
import type { LedgerEntryView, ReconciliationView, WalletView, WagerTransactionView } from '../src/api/wagering-api';
import {
  canReverseTransaction,
  clearRetryableRequest,
  createReversalPayload,
  evaluateConcurrencyAcceptance,
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

  test('confirma o cenário concorrente somente com dados de saldo, transações, ledger e reconciliação', () => {
    const processed = createTransaction({
      transactionId: 'bet-processada',
      externalTransactionId: 'bet-a',
      status: 'PROCESSED',
    });
    const rejected = createTransaction({
      transactionId: 'bet-rejeitada',
      externalTransactionId: 'bet-b',
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    const ledger: LedgerEntryView[] = [
      {
        id: 'abertura', transactionId: 'opening', direction: 'CREDIT',
        money: { amount: '100.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        createdAt: '2026-11-14T12:00:00.000Z',
      },
      {
        id: 'debito', transactionId: 'bet-processada', direction: 'DEBIT',
        money: { amount: '80.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '20.00', currency: 'BRL' },
        createdAt: '2026-11-14T12:00:01.000Z',
      },
    ];
    const wallet: WalletView = {
      id: 'carteira-1', playerId: 'jogador-1',
      balance: { amount: '20.00', currency: 'BRL' }, version: 2,
    };
    const reconciliation: ReconciliationView = {
      walletId: 'carteira-1',
      storedBalance: { amount: '20.00', currency: 'BRL' },
      calculatedBalance: { amount: '20.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    };

    expect(evaluateConcurrencyAcceptance([processed, rejected], ledger, wallet, reconciliation)).toEqual({
      twoBetsAreEighty: true,
      oneProcessed: true,
      oneRejectedForInsufficientFunds: true,
      oneDebitOfEighty: true,
      finalBalanceIsTwenty: true,
      reconciled: true,
      passed: true,
    });
    expect(evaluateConcurrencyAcceptance([processed, rejected], ledger.slice(0, 1), wallet, reconciliation).passed).toBe(false);
  });
});
