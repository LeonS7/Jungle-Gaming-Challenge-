/**
 * Esta página coordena claim, publicação SQS e retry das mensagens da outbox.
 * Assinatura: Leonardo de Souza da Luz
 */
import { OutboxMessage } from '../../domain/outbox/outbox-message.js';
import type {
  OutboxEventPublisherPort,
  OutboxPublishingPersistencePort,
} from './outbox-publishing.port.js';

const CLAIM_BATCH_SIZE = 10;
const CLAIM_LEASE_SECONDS = 45;

export interface OutboxPublicationFailure {
  readonly eventId: string;
  readonly eventType: string;
  readonly phase: 'send' | 'retry-schedule' | 'mark-published';
  readonly attempt: number;
  readonly errorName: string;
  readonly retryDelaySeconds?: number;
  readonly retryScheduled?: boolean;
}

export interface OutboxPublicationBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly retriesScheduled: number;
  readonly failures: readonly OutboxPublicationFailure[];
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Erro desconhecido';
}

export class PublishOutboxMessages {
  constructor(
    private readonly persistence: OutboxPublishingPersistencePort,
    private readonly publisher: OutboxEventPublisherPort,
  ) {}

  async executeBatch(): Promise<OutboxPublicationBatchResult> {
    const claims = await this.persistence.claimDueMessages(
      CLAIM_BATCH_SIZE,
      CLAIM_LEASE_SECONDS,
    );
    let published = 0;
    let retriesScheduled = 0;
    const failures: OutboxPublicationFailure[] = [];

    for (const claim of claims) {
      const message = OutboxMessage.rehydrate({
        id: claim.id,
        attempts: claim.attempts,
        nextAttemptAt: claim.nextAttemptAt,
      });

      try {
        await this.publisher.publish({
          eventId: claim.id,
          transactionId: claim.transactionId,
          payload: claim.payload,
        });
      } catch (error) {
        const retry = message.scheduleRetry(new Date());
        let retryScheduled = false;
        try {
          retryScheduled = await this.persistence.scheduleRetry(
            claim.id,
            claim.lockToken,
            retry.attempts,
            retry.delaySeconds,
          );
          if (retryScheduled) {
            retriesScheduled += 1;
          }
        } catch {
          // O lease vence sozinho caso o PostgreSQL também esteja indisponível.
        }
        failures.push({
          eventId: claim.id,
          eventType: claim.eventType,
          phase: 'send',
          attempt: retry.attempts,
          errorName: errorName(error),
          retryDelaySeconds: retry.delaySeconds,
          retryScheduled,
        });
        continue;
      }

      const publishedAt = new Date();
      message.markPublished(publishedAt);
      try {
        const marked = await this.persistence.markPublished(
          claim.id,
          claim.lockToken,
          publishedAt,
        );
        if (marked) {
          published += 1;
        } else {
          failures.push({
            eventId: claim.id,
            eventType: claim.eventType,
            phase: 'mark-published',
            attempt: claim.attempts,
            errorName: 'Lease da mensagem não pertence mais a este publisher',
          });
        }
      } catch (error) {
        failures.push({
          eventId: claim.id,
          eventType: claim.eventType,
          phase: 'mark-published',
          attempt: claim.attempts,
          errorName: errorName(error),
        });
      }
    }

    return {
      claimed: claims.length,
      published,
      retriesScheduled,
      failures,
    };
  }
}
