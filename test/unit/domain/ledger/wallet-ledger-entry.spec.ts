/**
 * Esta página testa a aritmética, integridade e imutabilidade do ledger.
 * Assinatura: Leonardo de Souza da Luz
 */
import { describe, expect, test } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../../../../src/domain/ledger/wallet-ledger-entry.js';
import { Money } from '../../../../src/domain/money/money.js';

const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

const validEntry = (overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) =>
  WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.Debit,
    money: money('5.00'),
    balanceBefore: money('10.00'),
    balanceAfter: money('5.00'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

describe('WalletLedgerEntry', () => {
  test('valida a aritmética de débito e crédito', () => {
    const debit = validEntry();
    const credit = validEntry({
      direction: LedgerDirection.Credit,
      balanceBefore: money('10.00'),
      balanceAfter: money('15.00'),
    });

    expect(debit.isBalanced()).toBe(true);
    expect(credit.isBalanced()).toBe(true);
  });

  test('rejeita aritmética divergente, saldo negativo, movimento zero e moeda diferente', () => {
    expect(() => validEntry({ balanceAfter: money('4.99') })).toThrow(
      'O saldo final não corresponde',
    );
    expect(() =>
      validEntry({ balanceAfter: money('-1.00'), balanceBefore: money('4.00') }),
    ).toThrow('Os saldos do lançamento não podem ser negativos.');
    expect(() => validEntry({ money: money('0.00') })).toThrow('deve ser positivo');
    expect(() => validEntry({ money: money('5.00', 'USD') })).toThrow(
      'mesma moeda',
    );
  });

  test('é estruturalmente imutável e retorna uma cópia da data', () => {
    const entry = validEntry();
    const exposedDate = entry.createdAt;
    exposedDate.setUTCFullYear(1999);

    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('a reidratação preserva os dados para a reconciliação identificar inconsistências', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Debit,
      money: money('5.00'),
      balanceBefore: money('10.00'),
      balanceAfter: money('6.00'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(entry.isBalanced()).toBe(false);
  });
});
