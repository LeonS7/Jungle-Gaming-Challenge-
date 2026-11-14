/**
 * Esta página modela o retry e a conclusão de uma mensagem da outbox.
 * Assinatura: Leonardo de Souza da Luz
 */
export interface OutboxMessageState {
  readonly id: string;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly publishedAt?: Date;
}

export interface OutboxRetrySchedule {
  readonly attempts: number;
  readonly delaySeconds: number;
  readonly nextAttemptAt: Date;
}

export class InvalidOutboxMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutboxMessageError';
  }
}

export class InvalidOutboxMessageStateError extends Error {
  constructor(operation: string) {
    super(`Não é possível ${operation} uma mensagem já publicada na outbox.`);
    this.name = 'InvalidOutboxMessageStateError';
  }
}

const MAX_RETRY_DELAY_SECONDS = 60;

function copyValidDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidOutboxMessageError(`${name} deve ser uma data válida.`);
  }
  return new Date(value.getTime());
}

export class OutboxMessage {
  private attemptsValue: number;
  private nextAttemptAtValue: Date;
  private publishedAtValue?: Date;

  private constructor(
    public readonly id: string,
    attempts: number,
    nextAttemptAt: Date,
    publishedAt?: Date,
  ) {
    if (id.trim().length === 0) {
      throw new InvalidOutboxMessageError('id deve ser uma string não vazia.');
    }
    if (!Number.isInteger(attempts) || attempts < 0) {
      throw new InvalidOutboxMessageError('attempts deve ser um inteiro não negativo.');
    }

    this.attemptsValue = attempts;
    this.nextAttemptAtValue = copyValidDate(nextAttemptAt, 'nextAttemptAt');
    this.publishedAtValue = publishedAt
      ? copyValidDate(publishedAt, 'publishedAt')
      : undefined;
    Object.seal(this);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this.attemptsValue;
  }

  get nextAttemptAt(): Date {
    return new Date(this.nextAttemptAtValue.getTime());
  }

  get publishedAt(): Date | undefined {
    return this.publishedAtValue
      ? new Date(this.publishedAtValue.getTime())
      : undefined;
  }

  isPending(): boolean {
    return this.publishedAtValue === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() &&
      this.nextAttemptAtValue.getTime() <= copyValidDate(now, 'now').getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageStateError('publicar');
    }
    this.publishedAtValue = copyValidDate(at, 'publishedAt');
  }

  scheduleRetry(now: Date): OutboxRetrySchedule {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageStateError('agendar novamente');
    }
    const failedAt = copyValidDate(now, 'now');
    this.attemptsValue += 1;
    const delaySeconds = Math.min(
      2 ** Math.min(this.attemptsValue - 1, 6),
      MAX_RETRY_DELAY_SECONDS,
    );
    this.nextAttemptAtValue = new Date(
      failedAt.getTime() + delaySeconds * 1000,
    );

    return {
      attempts: this.attemptsValue,
      delaySeconds,
      nextAttemptAt: this.nextAttemptAt,
    };
  }
}
