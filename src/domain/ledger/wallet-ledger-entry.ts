/**
 * Esta página define o lançamento imutável do ledger e valida sua aritmética.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Money } from '../money/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateWalletLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export interface WalletLedgerEntryState extends CreateWalletLedgerEntryProps {}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

function requireIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidLedgerEntryError(`${name} deve ser uma string não vazia.`);
  }
}

function copyValidDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidLedgerEntryError(`${name} deve ser uma data válida.`);
  }

  return new Date(value.getTime());
}

/**
 * Registro imutável de auditoria de uma movimentação de saldo.
 * A reidratação preserva o estado persistido; isBalanced() pode então
 * identificar dados históricos inconsistentes sem ocultá-los.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.createdAtValue = new Date(createdAt.getTime());
    Object.freeze(this);
  }

  private readonly createdAtValue: Date;

  get createdAt(): Date {
    return new Date(this.createdAtValue.getTime());
  }

  static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    requireIdentifier(props.id, 'id');
    requireIdentifier(props.walletId, 'walletId');
    requireIdentifier(props.transactionId, 'transactionId');

    if (!Object.values(LedgerDirection).includes(props.direction)) {
      throw new InvalidLedgerEntryError('A direção do lançamento é inválida.');
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('O valor do lançamento deve ser positivo.');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Os saldos do lançamento não podem ser negativos.');
    }
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError('Os valores do lançamento devem usar a mesma moeda.');
    }
    copyValidDate(props.createdAt, 'createdAt');

    const expectedAfter =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.balanceBefore.add(props.money);

    if (!expectedAfter.equals(props.balanceAfter)) {
      throw new InvalidLedgerEntryError(
        'O saldo final não corresponde à direção e ao valor do lançamento.',
      );
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    if (
      !Object.values(LedgerDirection).includes(this.direction) ||
      !this.money.isPositive() ||
      this.balanceBefore.isNegative() ||
      this.balanceAfter.isNegative() ||
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    const expectedAfter =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expectedAfter.equals(this.balanceAfter);
  }
}
