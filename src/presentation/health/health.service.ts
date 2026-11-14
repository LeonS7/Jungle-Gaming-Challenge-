/**
 * Esta página verifica a disponibilidade de PostgreSQL e SQS para readiness.
 * Assinatura: Leonardo de Souza da Luz
 */
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import type { ApplicationConfig } from '../../config/application-config.js';
import { APPLICATION_CONFIG } from '../../config/config.constants.js';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly sqsClient: SQSClient;

  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(MikroORM)
    private readonly orm: MikroORM,
  ) {
    this.sqsClient = new SQSClient({
      region: config.sqs.region,
      endpoint: config.sqs.endpoint,
      credentials: {
        accessKeyId: config.sqs.accessKeyId,
        secretAccessKey: config.sqs.secretAccessKey,
      },
    });
  }

  async checkReadiness(): Promise<{
    status: 'ok';
    dependencies: { postgres: 'ok'; sqs: 'ok' };
  }> {
    const [postgresResult, wagerQueueResult, deadLetterQueueResult, outboxQueueResult] = await Promise.allSettled([
      this.checkPostgresConnection(),
      this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: this.config.sqs.queueName }),
      ),
      this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: this.config.sqs.deadLetterQueueName }),
      ),
      this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: this.config.sqs.outboxQueueName }),
      ),
    ]);

    const postgresIsReady =
      postgresResult.status === 'fulfilled' && postgresResult.value;
    const sqsIsReady = [
      wagerQueueResult,
      deadLetterQueueResult,
      outboxQueueResult,
    ].every((result) =>
      result.status === 'fulfilled' && Boolean(result.value.QueueUrl),
    );

    if (!postgresIsReady || !sqsIsReady) {
      throw new ServiceUnavailableException({
        status: 'error',
        dependencies: {
          postgres: postgresIsReady ? 'ok' : 'error',
          sqs: sqsIsReady ? 'ok' : 'error',
        },
      });
    }

    return {
      status: 'ok',
      dependencies: { postgres: 'ok', sqs: 'ok' },
    };
  }

  onModuleDestroy(): void {
    this.sqsClient.destroy();
  }

  private async checkPostgresConnection(): Promise<boolean> {
    await this.orm.connect();
    const result = await this.orm.checkConnection();
    return result.ok;
  }
}
