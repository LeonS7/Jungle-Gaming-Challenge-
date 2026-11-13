/**
 * Esta página modela transações de wagering, estados e regras de referência.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Money } from '../money/money.js';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Código estável legível por máquina; os casos de uso definem o catálogo. */
export type FailureCode = string;

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt?: Date;
}

export type CreateOpeningTransactionProps = Omit<
  CreateWagerTransactionProps,
  'kind'
>;

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(status: WagerTransactionStatus, operation: string) {
    super(`Não é possível ${operation} uma transação no estado ${status}.`);
    this.name = 'InvalidTransactionStateError';
  }
}

function requireIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidWagerTransactionError(`${name} deve ser uma string não vazia.`);
  }
}

function copyValidDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidWagerTransactionError(`${name} deve ser uma data válida.`);
  }

  return new Date(value.getTime());
}

function isFailureCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value);
}

const TERMINAL_STATUSES = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Estado de domínio de uma operação de wagering de um provedor. */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    processedAt?: Date,
  ) {
    this.createdAtValue = new Date(createdAt.getTime());
    this._processedAt = processedAt ? new Date(processedAt.getTime()) : undefined;
    Object.seal(this);
  }

  private readonly createdAtValue: Date;
  private _processedAt?: Date;

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'Transações OPENING só podem ser criadas por um fluxo interno.',
      );
    }

    return WagerTransaction.build({ ...props, createdAt: props.createdAt ?? new Date() });
  }

  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    return WagerTransaction.build({
      ...props,
      kind: WagerTransactionKind.Opening,
      createdAt: props.createdAt ?? new Date(),
    });
  }

  /** Restaura o estado persistido sem repetir transições de negócio. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.createdAtValue.getTime());
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertInFlight('processar');
    if (this.requiresReference()) {
      requireIdentifier(referenceTransactionId ?? '', 'referenceTransactionId');
    } else if (referenceTransactionId !== undefined) {
      requireIdentifier(referenceTransactionId, 'referenceTransactionId');
    }

    const processedAt = copyValidDate(at, 'processedAt');
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = processedAt;
    this._failureCode = undefined;
    this._status = WagerTransactionStatus.Processed;
  }

  markPendingReference(): void {
    this.assertInFlight('aguardar uma referência');
    if (
      !this.requiresReference() &&
      this.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidWagerTransactionError(
        `Transações ${this.kind} sem referência externa não podem aguardar uma referência.`,
      );
    }
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this._status, 'marcar como pendente de referência');
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.finishWithFailure(WagerTransactionStatus.Rejected, code, 'rejeitar');
  }

  fail(code: FailureCode): void {
    this.finishWithFailure(WagerTransactionStatus.Failed, code, 'marcar como falha');
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** LOSS é registrada, mas não altera o saldo da carteira. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Retorna undefined para LOSS, que não gera lançamento no ledger. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Refund:
        if (this.kind === WagerTransactionKind.Refund) {
          this.assertValidReversalReference(reference);
        }
        return LedgerDirection.Credit;
      case WagerTransactionKind.Win:
        if (reference) {
          this.assertValidWinReference(reference);
        }
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        this.assertValidReversalReference(reference);
        if (reference?.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }
        return LedgerDirection.Debit;
      }
    }
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    requireIdentifier(props.id, 'id');
    requireIdentifier(props.providerId, 'providerId');
    requireIdentifier(props.externalTransactionId, 'externalTransactionId');
    requireIdentifier(props.idempotencyKey, 'idempotencyKey');
    requireIdentifier(props.payloadHash, 'payloadHash');
    requireIdentifier(props.walletId, 'walletId');
    requireIdentifier(props.playerId, 'playerId');
    requireIdentifier(props.roundId, 'roundId');
    requireIdentifier(props.gameId, 'gameId');
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError('O tipo da transação é inválido.');
    }
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('O valor da transação deve ser positivo.');
    }

    if (props.referenceExternalTransactionId !== undefined) {
      requireIdentifier(props.referenceExternalTransactionId, 'referenceExternalTransactionId');
      if (
        props.kind !== WagerTransactionKind.Win &&
        props.kind !== WagerTransactionKind.Refund &&
        props.kind !== WagerTransactionKind.Rollback
      ) {
        throw new InvalidWagerTransactionError(
          `Transações ${props.kind} não aceitam referenceExternalTransactionId.`,
        );
      }
    }
    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && props.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        `Transações ${props.kind} exigem referenceExternalTransactionId.`,
      );
    }

    const createdAt = copyValidDate(props.createdAt ?? new Date(), 'createdAt');
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  private assertValidReversalReference(reference?: WagerTransaction): void {
    if (!reference) {
      throw new InvalidWagerTransactionError(`${this.kind} exige uma referência resolvida.`);
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidWagerTransactionError('A transação referenciada deve estar processada.');
    }

    const allowedKinds =
      this.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ];
    if (!allowedKinds.includes(reference.kind)) {
      throw new InvalidWagerTransactionError(
        `${this.kind} não pode reverter uma transação ${reference.kind}.`,
      );
    }
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.externalTransactionId !== this.referenceExternalTransactionId
    ) {
      throw new InvalidWagerTransactionError(
        'A referência deve corresponder ao provedor, jogador, carteira, rodada e ID externo.',
      );
    }
    if (
      this.referenceTransactionId !== undefined &&
      this.referenceTransactionId !== reference.id
    ) {
      throw new InvalidWagerTransactionError(
        'O ID interno da referência resolvida não corresponde.',
      );
    }
    if (!reference.money.equals(this.money)) {
      throw new InvalidWagerTransactionError(
        'O valor e a moeda da reversão devem corresponder à transação referenciada.',
      );
    }
  }

  private assertValidWinReference(reference: WagerTransaction): void {
    if (
      reference.kind !== WagerTransactionKind.Bet ||
      reference.status !== WagerTransactionStatus.Processed
    ) {
      throw new InvalidWagerTransactionError(
        'Uma referência resolvida de WIN deve ser uma BET processada.',
      );
    }
    if (
      this.referenceExternalTransactionId === undefined ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      throw new InvalidWagerTransactionError(
        'A referência de WIN deve corresponder ao provedor, jogador, carteira, rodada, ID externo e moeda.',
      );
    }
  }

  private assertInFlight(operation: string): void {
    if (
      this._status !== WagerTransactionStatus.Pending &&
      this._status !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidTransactionStateError(this._status, operation);
    }
  }

  private finishWithFailure(
    status: WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed,
    code: FailureCode,
    operation: string,
  ): void {
    this.assertInFlight(operation);
    if (
      this._status !== WagerTransactionStatus.Pending &&
      this._status !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidTransactionStateError(this._status, operation);
    }
    if (typeof code !== 'string' || !isFailureCode(code)) {
      throw new InvalidWagerTransactionError(
        'O código de falha deve ser um identificador legível por máquina em letras maiúsculas.',
      );
    }

    this._failureCode = code;
    this._status = status;
  }
}
