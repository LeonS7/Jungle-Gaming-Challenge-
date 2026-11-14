/**
 * Esta página executa o publisher da outbox até o encerramento gracioso.
 * Assinatura: Leonardo de Souza da Luz
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PublishOutboxMessages } from '../../application/outbox/publish-outbox-messages.js';
import { SqsOutboxEventPublisher } from './sqs-outbox-event-publisher.js';

const EMPTY_QUEUE_POLL_MILLISECONDS = 1000;

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly publishOutboxMessages: PublishOutboxMessages,
    private readonly sqsPublisher: SqsOutboxEventPublisher,
  ) {}

  onModuleInit(): void {
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.sqsPublisher.destroy();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.publishOutboxMessages.executeBatch();
        for (const failure of result.failures) {
          const details = JSON.stringify({
            event: `outbox.publisher.${failure.phase}_failed`,
            eventId: failure.eventId,
            eventType: failure.eventType,
            attempt: failure.attempt,
            errorName: failure.errorName,
            retryDelaySeconds: failure.retryDelaySeconds,
            retryScheduled: failure.retryScheduled,
          });
          if (failure.phase === 'send') {
            this.logger.warn(details);
          } else {
            this.logger.error(details);
          }
        }
        if (result.claimed === 0) {
          await this.wait(EMPTY_QUEUE_POLL_MILLISECONDS);
        }
      } catch (error) {
        this.logger.error(JSON.stringify({
          event: 'outbox.publisher.batch_failed',
          errorName: error instanceof Error ? error.name : 'Erro desconhecido',
        }));
        await this.wait(EMPTY_QUEUE_POLL_MILLISECONDS);
      }
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}
