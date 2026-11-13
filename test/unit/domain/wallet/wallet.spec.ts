/**
 * Esta página testa abertura, movimentações e invariantes da carteira.
 * Assinatura: Leonardo de Souza da Luz
 */
import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/domain/money/money.js';
import {
  InsufficientWalletBalanceError,
  InvalidWalletError,
  Wallet,
} from '../../../../src/domain/wallet/wallet.js';
import { LedgerDirection } from '../../../../src/domain/ledger/wallet-ledger-entry.js';

const money = (amount: string, currency = 'BRL'): Money =>
  Money.from({ amount, currency });

describe('Wallet', () => {
  test('abre com versão um e o saldo inicial em Money', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('100.00'),
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt.toISOString()).toBe(wallet.updatedAt.toISOString());
  });

  test('débito e crédito retornam lançamentos balanceados e incrementam a versão', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('100.00'),
    });
    const occurredAt = new Date('2026-01-02T03:04:05.000Z');

    const debit = wallet.debit({
      ledgerEntryId: 'entry-1',
      transactionId: 'transaction-1',
      money: money('25.00'),
      occurredAt,
    });
    const credit = wallet.credit({
      ledgerEntryId: 'entry-2',
      transactionId: 'transaction-2',
      money: money('10.00'),
      occurredAt,
    });

    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.toJSON().amount).toBe('100.00');
    expect(debit.balanceAfter.toJSON().amount).toBe('75.00');
    expect(debit.isBalanced()).toBe(true);
    expect(credit.direction).toBe(LedgerDirection.Credit);
    expect(credit.balanceBefore.toJSON().amount).toBe('75.00');
    expect(credit.balanceAfter.toJSON().amount).toBe('85.00');
    expect(credit.isBalanced()).toBe(true);
    expect(wallet.balance.toJSON().amount).toBe('85.00');
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt.toISOString()).toBe(occurredAt.toISOString());
  });

  test('não altera a carteira quando um débito deixaria o saldo negativo', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('20.00'),
    });

    expect(() =>
      wallet.debit({
        ledgerEntryId: 'entry-1',
        transactionId: 'transaction-1',
        money: money('20.01'),
      }),
    ).toThrow(InsufficientWalletBalanceError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  test('rejeita saldo inicial negativo, movimentação zero e moeda diferente', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('-0.01'),
      }),
    ).toThrow(InvalidWalletError);

    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('1.00'),
    });

    expect(() =>
      wallet.credit({
        ledgerEntryId: 'entry-1',
        transactionId: 'transaction-1',
        money: money('0.00'),
      }),
    ).toThrow(InvalidWalletError);
    expect(() =>
      wallet.credit({
        ledgerEntryId: 'entry-1',
        transactionId: 'transaction-1',
        money: money('1.00', 'USD'),
      }),
    ).toThrow(InvalidWalletError);
    expect(wallet.version).toBe(1);
  });

  test('retorna cópias das datas e reidrata o estado persistido', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const updatedAt = new Date('2026-01-02T00:00:00.000Z');
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: money('5.00'),
      version: 4,
      createdAt,
      updatedAt,
    });
    const exposedDate = wallet.updatedAt;
    exposedDate.setUTCFullYear(1999);

    expect(wallet.version).toBe(4);
    expect(wallet.updatedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});
