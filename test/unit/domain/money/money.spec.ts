/**
 * Esta página testa validações, aritmética decimal e imutabilidade de Money.
 * Assinatura: Leonardo de Souza da Luz
 */
import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from '../../../../src/domain/money/money.js';

describe('Money', () => {
  test('normaliza entradas inteiras ou com uma casa para duas casas decimais', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).toString()).toBe(
      '25.50 BRL',
    );
  });

  test('soma e subtrai decimais sem usar ponto flutuante binário', () => {
    const amount = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );

    expect(amount.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(
      amount.subtract(Money.from({ amount: '0.10', currency: 'BRL' })).toString(),
    ).toBe('0.20 BRL');
  });

  test('não arredonda somas grandes pela precisão padrão do decimal.js', () => {
    const amount = Money.from({
      amount: '999999999999999999999999999999.99',
      currency: 'BRL',
    }).add(Money.from({ amount: '0.01', currency: 'BRL' }));

    expect(amount.toJSON().amount).toBe('1000000000000000000000000000000.00');
  });

  test('permite aritmética com sinal e preserva a moeda', () => {
    const negative = Money.from({ amount: '25.00', currency: 'BRL' }).subtract(
      Money.from({ amount: '30.00', currency: 'BRL' }),
    );

    expect(negative.isNegative()).toBe(true);
    expect(negative.negate().toJSON()).toEqual({
      amount: '5.00',
      currency: 'BRL',
    });
    expect(Money.from({ amount: '-25.00', currency: 'BRL' }).toJSON().amount).toBe(
      '-25.00',
    );
  });

  test('informa sinal, zero, ordenação e igualdade', () => {
    const zero = Money.zero('BRL');
    const positive = Money.from({ amount: '1.00', currency: 'BRL' });

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(positive.isPositive()).toBe(true);
    expect(zero.isLessThan(positive)).toBe(true);
    expect(positive.equals(Money.from({ amount: '1', currency: 'BRL' }))).toBe(true);
    expect(positive.equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(
      false,
    );
  });

  test('lança erro ao operar ou ordenar moedas diferentes', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test.each([
    '',
    'NaN',
    'Infinity',
    '1e2',
    '1.234',
    ' 1.00',
    '1.',
    '+1.00',
  ])('rejeita o valor malformado %j', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'ZZZ'])('rejeita a moeda não suportada %j', (currency) => {
    expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
  });

  test('é imutável', () => {
    const amount = Money.from({ amount: '2.00', currency: 'BRL' });

    expect(Object.isFrozen(amount)).toBe(true);
    expect(amount.add(Money.from({ amount: '1.00', currency: 'BRL' })).toString()).toBe(
      '3.00 BRL',
    );
    expect(amount.toString()).toBe('2.00 BRL');
  });
});
