/**
 * Esta página representa valores monetários decimais e valida suas operações.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Decimal } from 'decimal.js';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(leftCurrency: string, rightCurrency: string) {
    super(`Não é possível operar valores nas moedas ${leftCurrency} e ${rightCurrency}.`);
    this.name = 'CurrencyMismatchError';
  }
}

// decimal.js arredonda operações conforme a precisão configurada.
// Money usa soma, subtração, negação e comparação exatas; por isso, cria
// um construtor isolado com a precisão máxima sem alterar a configuração global.
const ExactDecimal = Decimal.clone({ precision: 1_000_000_000 });
type DecimalValue = InstanceType<typeof ExactDecimal>;

const AMOUNT_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;
const ISO_4217_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

function validateCurrency(currency: unknown): asserts currency is string {
  if (
    typeof currency !== 'string' ||
    !/^[A-Z]{3}$/.test(currency) ||
    !ISO_4217_CURRENCIES.has(currency)
  ) {
    throw new InvalidMoneyError('A moeda deve ser um código ISO-4217 válido e suportado.');
  }
}

export class Money {
  private constructor(
    private readonly value: DecimalValue,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props !== 'object' || props === null) {
      throw new InvalidMoneyError('Os dados de Money devem formar um objeto.');
    }

    validateCurrency(props.currency);

    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        'O valor deve ser uma string decimal simples com no máximo duas casas decimais.',
      );
    }

    return new Money(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    validateCurrency(currency);
    return new Money(new ExactDecimal('0'), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan('0');
  }

  isNegative(): boolean {
    return this.value.lessThan('0');
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.amountAsString(),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.amountAsString()} ${this.currency}`;
  }

  private amountAsString(): string {
    return this.value.isZero() ? '0.00' : this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
