/**
 * Esta página aplica backoff e TTL às referências de wagering fora de ordem.
 * Assinatura: Leonardo de Souza da Luz
 */
export interface PendingReferenceRetryState {
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly expiresAt: Date;
}

export interface PendingReferenceRetrySchedule {
  readonly attempts: number;
  readonly delaySeconds: number;
  readonly nextAttemptAt: Date;
}

export class InvalidPendingReferenceRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPendingReferenceRetryError';
  }
}

export const PENDING_REFERENCE_TTL_SECONDS = 24 * 60 * 60;
export const INITIAL_PENDING_REFERENCE_DELAY_SECONDS = 1;
export const MAX_PENDING_REFERENCE_DELAY_SECONDS = 5 * 60;

function copyValidDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidPendingReferenceRetryError(`${name} deve ser uma data válida.`);
  }
  return new Date(value.getTime());
}

export class PendingReferenceRetry {
  private attemptsValue: number;
  private nextAttemptAtValue: Date;
  private readonly expiresAtValue: Date;

  private constructor(state: PendingReferenceRetryState) {
    if (!Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new InvalidPendingReferenceRetryError(
        'attempts deve ser um inteiro não negativo.',
      );
    }
    this.attemptsValue = state.attempts;
    this.nextAttemptAtValue = copyValidDate(state.nextAttemptAt, 'nextAttemptAt');
    this.expiresAtValue = copyValidDate(state.expiresAt, 'expiresAt');
    if (this.nextAttemptAtValue.getTime() > this.expiresAtValue.getTime()) {
      throw new InvalidPendingReferenceRetryError(
        'nextAttemptAt não pode ultrapassar expiresAt.',
      );
    }
    Object.seal(this);
  }

  static rehydrate(state: PendingReferenceRetryState): PendingReferenceRetry {
    return new PendingReferenceRetry(state);
  }

  get attempts(): number {
    return this.attemptsValue;
  }

  get nextAttemptAt(): Date {
    return new Date(this.nextAttemptAtValue.getTime());
  }

  get expiresAt(): Date {
    return new Date(this.expiresAtValue.getTime());
  }

  isExpired(now: Date): boolean {
    return copyValidDate(now, 'now').getTime() >= this.expiresAtValue.getTime();
  }

  scheduleRetry(now: Date): PendingReferenceRetrySchedule {
    const scheduledAt = copyValidDate(now, 'now');
    if (this.isExpired(scheduledAt)) {
      throw new InvalidPendingReferenceRetryError(
        'Uma referência expirada não pode receber outra tentativa.',
      );
    }

    this.attemptsValue += 1;
    const delaySeconds = Math.min(
      2 ** Math.min(this.attemptsValue - 1, 9),
      MAX_PENDING_REFERENCE_DELAY_SECONDS,
    );
    const nextAttemptAt = new Date(Math.min(
      scheduledAt.getTime() + delaySeconds * 1000,
      this.expiresAtValue.getTime(),
    ));
    this.nextAttemptAtValue = nextAttemptAt;

    return {
      attempts: this.attemptsValue,
      delaySeconds,
      nextAttemptAt: this.nextAttemptAt,
    };
  }
}
