/**
 * Esta página define a carteira, suas regras de saldo e os lançamentos gerados.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Money } from '../money/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../ledger/wallet-ledger-entry.js';

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletMovementProps {
  readonly ledgerEntryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly occurredAt?: Date;
}

export class InvalidWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletError';
  }
}

export class InsufficientWalletBalanceError extends Error {
  constructor() {
    super('O saldo da carteira é insuficiente para este débito.');
    this.name = 'InsufficientWalletBalanceError';
  }
}

function requireIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidWalletError(`${name} deve ser uma string não vazia.`);
  }
}

function copyValidDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidWalletError(`${name} deve ser uma data válida.`);
  }

  return new Date(value.getTime());
}

/** Raiz do agregado da carteira; a persistência deve salvar cada movimento atomicamente. */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.createdAtValue = new Date(createdAt.getTime());
    this._updatedAt = new Date(updatedAt.getTime());
  }

  private readonly createdAtValue: Date;
  private _updatedAt: Date;

  static open(props: OpenWalletProps): Wallet {
    requireIdentifier(props.id, 'id');
    requireIdentifier(props.playerId, 'playerId');

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('O saldo inicial não pode ser negativo.');
    }

    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Restaura os dados persistidos sem repetir regras de abertura ou movimentação. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this.createdAtValue.getTime());
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    return this.applyMovement(props, LedgerDirection.Debit);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    return this.applyMovement(props, LedgerDirection.Credit);
  }

  private applyMovement(
    props: WalletMovementProps,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    requireIdentifier(props.ledgerEntryId, 'ledgerEntryId');
    requireIdentifier(props.transactionId, 'transactionId');
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidWalletError('O valor da movimentação deve ser positivo.');
    }
    if (this._balance.isNegative()) {
      throw new InvalidWalletError('O saldo persistido da carteira não pode ser negativo.');
    }
    if (!Number.isSafeInteger(this._version) || this._version < 1) {
      throw new InvalidWalletError('A versão da carteira deve ser um inteiro seguro positivo.');
    }
    if (this._version === Number.MAX_SAFE_INTEGER) {
      throw new InvalidWalletError('Não é possível incrementar a versão da carteira com segurança.');
    }

    const occurredAt = copyValidDate(props.occurredAt ?? new Date(), 'occurredAt');
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(props.money)
        : balanceBefore.add(props.money);

    if (balanceAfter.isNegative()) {
      throw new InsufficientWalletBalanceError();
    }

    // Valida e cria o registro imutável antes de alterar o agregado.
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: occurredAt,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = occurredAt;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new InvalidWalletError(
        `A moeda da carteira (${this.currency}) difere da moeda da movimentação (${money.currency}).`,
      );
    }
  }
}
