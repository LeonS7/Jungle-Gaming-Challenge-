/**
 * Esta página envia envelopes imutáveis à fila FIFO de eventos financeiros.
 * Assinatura: Leonardo de Souza da Luz
 */
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import type {
  OutboxEventPublisherPort,
  OutboxEventToPublish,
} from '../../application/outbox/outbox-publishing.port.js';
import type { ApplicationConfig } from '../../config/application-config.js';
import { APPLICATION_CONFIG } from '../../config/config.constants.js';

@Injectable()
export class SqsOutboxEventPublisher implements OutboxEventPublisherPort {
  private readonly client: SQSClient;
  private queueUrl: string | undefined;
  private queueUrlRequest: Promise<string> | undefined;

  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {
    this.client = new SQSClient({
      region: config.sqs.region,
      endpoint: config.sqs.endpoint,
      credentials: {
        accessKeyId: config.sqs.accessKeyId,
        secretAccessKey: config.sqs.secretAccessKey,
      },
    });
  }

  async publish(event: OutboxEventToPublish): Promise<void> {
    const queueUrl = await this.resolveQueueUrl();
    await this.client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(event.payload),
      MessageGroupId: event.transactionId,
      MessageDeduplicationId: event.eventId,
    }));
  }

  destroy(): void {
    this.client.destroy();
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl) {
      return this.queueUrl;
    }
    if (this.queueUrlRequest) {
      return this.queueUrlRequest;
    }

    this.queueUrlRequest = this.client.send(
      new GetQueueUrlCommand({ QueueName: this.config.sqs.outboxQueueName }),
    ).then((response) => {
      if (!response.QueueUrl) {
        throw new Error('A fila SQS de eventos não retornou uma URL.');
      }
      this.queueUrl = response.QueueUrl;
      return response.QueueUrl;
    }).finally(() => {
      this.queueUrlRequest = undefined;
    });
    return this.queueUrlRequest;
  }
}
