/**
 * Esta página define as portas de claim PostgreSQL e publicação de eventos.
 * Assinatura: Leonardo de Souza da Luz
 */
export interface ClaimedOutboxMessage {
  readonly id: string;
  readonly transactionId: string;
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lockToken: string;
}

export interface OutboxEventToPublish {
  readonly eventId: string;
  readonly transactionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxPublishingPersistencePort {
  getOutboxLagSeconds(): Promise<number>;
  claimDueMessages(
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly ClaimedOutboxMessage[]>;
  markPublished(
    id: string,
    lockToken: string,
    publishedAt: Date,
  ): Promise<boolean>;
  scheduleRetry(
    id: string,
    lockToken: string,
    attempts: number,
    delaySeconds: number,
  ): Promise<boolean>;
}

export interface OutboxEventPublisherPort {
  publish(event: OutboxEventToPublish): Promise<void>;
}
