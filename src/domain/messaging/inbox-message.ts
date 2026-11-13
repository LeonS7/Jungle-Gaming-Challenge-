/**
 * Esta página modela a identidade persistente e o processamento de uma mensagem recebida.
 * Assinatura: Leonardo de Souza da Luz
 */
export interface ReceiveInboxMessageProps {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt?: Date;
}

export interface InboxMessageState {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  readonly processedAt?: Date;
}

export class InvalidInboxMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInboxMessageError';
  }
}

export class InvalidInboxMessageStateError extends Error {
  constructor(operation: string) {
    super(`Não é possível ${operation} uma mensagem da inbox neste estado.`);
    this.name = 'InvalidInboxMessageStateError';
  }
}

function requireText(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidInboxMessageError(`${name} deve ser uma string não vazia.`);
  }
}

function copyValidDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidInboxMessageError(`${name} deve ser uma data válida.`);
  }
  return new Date(value.getTime());
}

export class InboxMessage {
  private constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
    public readonly payloadHash: string,
    receivedAt: Date,
    processedAt?: Date,
  ) {
    this.receivedAtValue = new Date(receivedAt.getTime());
    this.processedAtValue = processedAt
      ? new Date(processedAt.getTime())
      : undefined;
    Object.seal(this);
  }

  private readonly receivedAtValue: Date;
  private processedAtValue?: Date;

  static receive(props: ReceiveInboxMessageProps): InboxMessage {
    requireText(props.consumerName, 'consumerName');
    requireText(props.messageId, 'messageId');
    if (!/^[0-9a-f]{64}$/.test(props.payloadHash)) {
      throw new InvalidInboxMessageError(
        'payloadHash deve ser um SHA-256 hexadecimal em letras minúsculas.',
      );
    }

    return new InboxMessage(
      props.consumerName,
      props.messageId,
      props.payloadHash,
      copyValidDate(props.receivedAt ?? new Date(), 'receivedAt'),
    );
  }

  /** Restaura o estado persistido sem repetir uma transição de processamento. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.consumerName,
      state.messageId,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get receivedAt(): Date {
    return new Date(this.receivedAtValue.getTime());
  }

  get processedAt(): Date | undefined {
    return this.processedAtValue
      ? new Date(this.processedAtValue.getTime())
      : undefined;
  }

  isProcessed(): boolean {
    return this.processedAtValue !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxMessageStateError('processar');
    }
    this.processedAtValue = copyValidDate(at, 'processedAt');
  }
}
