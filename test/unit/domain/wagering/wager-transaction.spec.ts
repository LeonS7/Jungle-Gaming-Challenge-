/**
 * Esta página testa tipos, transições e referências de transações de wagering.
 * Assinatura: Leonardo de Souza da Luz
 */
import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../../src/domain/ledger/wallet-ledger-entry.js';
import { Money } from '../../../../src/domain/money/money.js';
import {
  CreateWagerTransactionProps,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../src/domain/wagering/wager-transaction.js';

const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

function transaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-1:external-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: money('10.00'),
    ...overrides,
  });
}

function processedReference(
  kind: WagerTransactionKind,
  externalTransactionId = 'external-1',
  value = money('10.00'),
): WagerTransaction {
  const reference = transaction({
    id: 'reference-internal-id',
    externalTransactionId,
    idempotencyKey: 'reference-key',
    kind,
    money: value,
    referenceExternalTransactionId:
      kind === WagerTransactionKind.Refund ? 'original-bet-external-id' : undefined,
  });
  reference.markProcessed(
    kind === WagerTransactionKind.Refund ? 'original-bet-internal-id' : undefined,
    new Date('2026-01-01T00:00:00.000Z'),
  );
  return reference;
}

describe('WagerTransaction', () => {
  test('cria transações normais em PENDING e reserva OPENING para uso interno', () => {
    expect(transaction().status).toBe(WagerTransactionStatus.Pending);
    expect(() => transaction({ kind: WagerTransactionKind.Opening })).toThrow(
      'fluxo interno',
    );

    const opening = WagerTransaction.createOpening({
      id: 'opening-1',
      providerId: 'internal',
      externalTransactionId: 'opening-external-1',
      idempotencyKey: 'opening:wallet-1',
      payloadHash: 'opening-hash',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'opening',
      gameId: 'system',
      money: money('10.00'),
    });

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Pending);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('exige referência externa para REFUND e ROLLBACK', () => {
    expect(() => transaction({ kind: WagerTransactionKind.Refund })).toThrow(
      'exigem referenceExternalTransactionId',
    );
    expect(() => transaction({ kind: WagerTransactionKind.Rollback })).toThrow(
      'exigem referenceExternalTransactionId',
    );
    expect(
      transaction({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'external-1',
      }).requiresReference(),
    ).toBe(true);
    expect(() => transaction({
      kind: WagerTransactionKind.Bet,
      referenceExternalTransactionId: 'unexpected-reference',
    })).toThrow('não aceitam referenceExternalTransactionId');
  });

  test('transiciona transações pendentes e impede mudanças após estados terminais', () => {
    const pendingReference = transaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });
    pendingReference.markPendingReference();
    expect(pendingReference.status).toBe(WagerTransactionStatus.PendingReference);
    pendingReference.markProcessed('bet-internal-id', new Date('2026-01-02T00:00:00Z'));
    expect(pendingReference.status).toBe(WagerTransactionStatus.Processed);
    expect(pendingReference.referenceTransactionId).toBe('bet-internal-id');
    expect(pendingReference.processedAt?.toISOString()).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    expect(pendingReference.isTerminal()).toBe(true);
    expect(() => pendingReference.reject('BUSINESS_REJECTED')).toThrow(
      InvalidTransactionStateError,
    );

    const rejected = transaction();
    rejected.reject('INSUFFICIENT_FUNDS');
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.isTerminal()).toBe(true);

    const failed = transaction();
    failed.fail('PERMANENT_PROCESSING_FAILURE');
    expect(failed.status).toBe(WagerTransactionStatus.Failed);
    expect(failed.failureCode).toBe('PERMANENT_PROCESSING_FAILURE');
  });

  test('transações sem referência externa não podem aguardar uma referência', () => {
    expect(() => transaction().markPendingReference()).toThrow(
      'sem referência externa não podem aguardar',
    );
    const pendingReference = transaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'bet-1',
    });
    pendingReference.markPendingReference();
    expect(() => pendingReference.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );

    const winWaitingForOptionalReference = transaction({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'bet-1',
    });
    winWaitingForOptionalReference.markPendingReference();
    expect(winWaitingForOptionalReference.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
  });

  test('valida códigos de falha legíveis por máquina antes da transição terminal', () => {
    const wager = transaction();
    expect(() => wager.reject('not stable')).toThrow('legível por máquina');
    expect(wager.status).toBe(WagerTransactionStatus.Pending);
  });

  test('classifica efeitos no ledger e compara hashes do payload', () => {
    expect(transaction().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(
      transaction({ kind: WagerTransactionKind.Win }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    const loss = transaction({ kind: WagerTransactionKind.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.ledgerDirectionFor()).toBeUndefined();
    expect(transaction().matchesPayload('hash-1')).toBe(true);
    expect(transaction().matchesPayload('different-hash')).toBe(false);
  });

  test('aceita referência opcional de WIN somente para BET processada da mesma rodada', () => {
    const win = transaction({
      kind: WagerTransactionKind.Win,
      externalTransactionId: 'win-1',
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });
    const bet = processedReference(WagerTransactionKind.Bet, 'bet-1');

    expect(win.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(() =>
      win.ledgerDirectionFor(
        processedReference(WagerTransactionKind.Bet, 'other-bet'),
      ),
    ).toThrow('A referência de WIN deve corresponder');
  });

  test('reembolsa somente uma BET processada correspondente e credita a carteira', () => {
    const refund = transaction({
      kind: WagerTransactionKind.Refund,
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: 'bet-1',
    });
    const bet = processedReference(WagerTransactionKind.Bet, 'bet-1');

    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(() =>
      refund.ledgerDirectionFor(
        processedReference(WagerTransactionKind.Win, 'bet-1'),
      ),
    ).toThrow('não pode reverter uma transação WIN');
    expect(() =>
      refund.ledgerDirectionFor(
        processedReference(WagerTransactionKind.Bet, 'bet-1', money('9.00')),
      ),
    ).toThrow('O valor e a moeda da reversão devem corresponder');
  });

  test('reverte BET, WIN ou REFUND na direção financeira inversa', () => {
    const rollback = (externalTransactionId: string) =>
      transaction({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: externalTransactionId,
      });

    expect(
      rollback('bet-1').ledgerDirectionFor(
        processedReference(WagerTransactionKind.Bet, 'bet-1'),
      ),
    ).toBe(LedgerDirection.Credit);
    expect(
      rollback('win-1').ledgerDirectionFor(
        processedReference(WagerTransactionKind.Win, 'win-1'),
      ),
    ).toBe(LedgerDirection.Debit);
    expect(
      rollback('refund-1').ledgerDirectionFor(
        processedReference(WagerTransactionKind.Refund, 'refund-1'),
      ),
    ).toBe(LedgerDirection.Debit);
    expect(() => rollback('loss-1').ledgerDirectionFor(
      processedReference(WagerTransactionKind.Loss, 'loss-1'),
    )).toThrow('não pode reverter uma transação LOSS');
  });

  test('exige que a referência de reversão corresponda ao provedor, jogador, carteira, rodada e estado', () => {
    const rollback = transaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'bet-1',
    });
    const wrongOwner = processedReference(WagerTransactionKind.Bet, 'bet-1');
    const differentWallet = transaction({
      id: 'other-reference',
      externalTransactionId: 'bet-1',
      idempotencyKey: 'other-key',
      walletId: 'wallet-2',
      kind: WagerTransactionKind.Bet,
    });
    differentWallet.markProcessed(undefined, new Date());

    expect(() => rollback.ledgerDirectionFor()).toThrow('exige uma referência resolvida');
    expect(() => rollback.ledgerDirectionFor(differentWallet)).toThrow(
      'deve corresponder ao provedor, jogador, carteira, rodada',
    );
    expect(wrongOwner.status).toBe(WagerTransactionStatus.Processed);
  });

  test('exige valor positivo e reidrata o estado sem repetir transições', () => {
    expect(() => transaction({ money: money('0.00') })).toThrow(
      'O valor da transação deve ser positivo.',
    );

    const terminal = WagerTransaction.rehydrate({
      id: 'transaction-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      idempotencyKey: 'provider-1:external-1',
      payloadHash: 'hash-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: money('10.00'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      status: WagerTransactionStatus.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
    });

    expect(terminal.status).toBe(WagerTransactionStatus.Rejected);
    expect(terminal.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(() => terminal.markProcessed(undefined, new Date())).toThrow(
      InvalidTransactionStateError,
    );
  });
});
