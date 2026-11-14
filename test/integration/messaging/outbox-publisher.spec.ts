/**
 * Esta página valida publicação, retry, concorrência e recuperação da outbox.
 * Assinatura: Leonardo de Souza da Luz
 */
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutboxMessages } from '../../../src/application/outbox/publish-outbox-messages.js';
import { OpenWallet } from '../../../src/application/wallets/open-wallet.js';
import { Money } from '../../../src/domain/money/money.js';
import { OutboxPublisherWorker } from '../../../src/infrastructure/messaging/outbox-publisher-worker.js';
import { SqsOutboxEventPublisher } from '../../../src/infrastructure/messaging/sqs-outbox-event-publisher.js';
import { loadApplicationConfig } from '../../../src/config/application-config.js';
import { createMikroOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.options.js';
import { PostgresOutboxPublishing } from '../../../src/infrastructure/persistence/postgres-outbox-publishing.js';
import { PostgresWalletOpeningPersistence } from '../../../src/infrastructure/persistence/postgres-wallet-opening-persistence.js';

function table(schema: string, name: string): string {
  return `"${schema}"."${name}"`;
}

interface OutboxTestContext {
  readonly config: ReturnType<typeof loadApplicationConfig>;
  readonly schema: string;
  readonly administrator: MikroORM;
  readonly orm: MikroORM;
  readonly sqs: SQSClient;
  close(): Promise<void>;
}

async function createContext(outboxQueueName: string): Promise<OutboxTestContext> {
  const baseConfig = loadApplicationConfig();
  const config = {
    ...baseConfig,
    sqs: { ...baseConfig.sqs, outboxQueueName },
  };
  const schema = `teste_outbox_${randomUUID().replaceAll('-', '')}`;
  const administrator = await MikroORM.init(createMikroOrmOptions(config));
  let orm: MikroORM | undefined;
  const sqs = new SQSClient({
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    credentials: {
      accessKeyId: config.sqs.accessKeyId,
      secretAccessKey: config.sqs.secretAccessKey,
    },
  });

  try {
    await administrator.em.getConnection().execute(`create schema "${schema}"`);
    orm = await MikroORM.init(createMikroOrmOptions(config, schema));
    await orm.migrator.up();
  } catch (error) {
    if (orm) {
      await orm.close(true);
    }
    await administrator.em.getConnection().execute(
      `drop schema if exists "${schema}" cascade`,
    );
    await administrator.close(true);
    sqs.destroy();
    throw error;
  }

  const scopedOrm = orm;
  return {
    config,
    schema,
    administrator,
    orm: scopedOrm,
    sqs,
    async close(): Promise<void> {
      await scopedOrm.close(true);
      await administrator.em.getConnection().execute(
        `drop schema if exists "${schema}" cascade`,
      );
      await administrator.close(true);
      sqs.destroy();
    },
  };
}

async function createEventQueue(sqs: SQSClient, queueName: string): Promise<string> {
  const response = await sqs.send(new CreateQueueCommand({
    QueueName: queueName,
    Attributes: {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
    },
  }));
  if (!response.QueueUrl) {
    throw new Error('LocalStack não retornou a URL da fila de eventos.');
  }
  return response.QueueUrl;
}

async function openWallet(context: OutboxTestContext): Promise<string> {
  const result = await new OpenWallet(
    new PostgresWalletOpeningPersistence(context.orm, context.schema),
  ).execute({
    playerId: `jogador-${randomUUID()}`,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  return result.id;
}

async function visibleMessages(sqs: SQSClient, queueUrl: string): Promise<number> {
  const result = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages'],
  }));
  return Number(result.Attributes?.ApproximateNumberOfMessages ?? '0');
}

async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Tempo esgotado aguardando ${description}.`);
}

async function publishUntilIdle(
  publishers: readonly PublishOutboxMessages[],
): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    const results = await Promise.all(
      publishers.map((publisher) => publisher.executeBatch()),
    );
    if (results.every((result) => result.claimed === 0)) {
      return;
    }
  }
  throw new Error('O publisher não esvaziou os eventos elegíveis da outbox.');
}

async function readPublishedEvents(
  context: OutboxTestContext,
  queueUrl: string,
): Promise<readonly { readonly Body?: string; readonly ReceiptHandle?: string }[]> {
  const response = await context.sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
  }));
  return response.Messages ?? [];
}

async function deleteReceivedEvents(
  context: OutboxTestContext,
  queueUrl: string,
  messages: readonly { readonly ReceiptHandle?: string }[],
): Promise<void> {
  for (const message of messages) {
    if (message.ReceiptHandle) {
      await context.sqs.send(new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }));
    }
  }
}

test('publisher concorrente recupera lease vencido e preserva ordem e deduplicação', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const queueName = `wager-events-test-${suffix}.fifo`;
  const context = await createContext(queueName);
  const firstSqsPublisher = new SqsOutboxEventPublisher(context.config);
  const secondSqsPublisher = new SqsOutboxEventPublisher(context.config);
  const firstPublisher = new PublishOutboxMessages(
    new PostgresOutboxPublishing(context.orm, context.schema),
    firstSqsPublisher,
  );
  const secondPublisher = new PublishOutboxMessages(
    new PostgresOutboxPublishing(context.orm, context.schema),
    secondSqsPublisher,
  );
  let queueUrl: string | undefined;

  try {
    queueUrl = await createEventQueue(context.sqs, queueName);
    await openWallet(context);
    const initialRows = await context.orm.em.getConnection().execute(
      `select "id"::text as "id", "sequence_number" as "sequenceNumber",
              "event_type" as "eventType", "published_at" is null as "pending"
       from ${table(context.schema, 'outbox_messages')} order by "sequence_number"`,
    );
    expect(initialRows).toHaveLength(2);
    expect(initialRows.map(({ sequenceNumber }) => sequenceNumber)).toEqual([1, 2]);
    expect(initialRows.every((row) => row.pending)).toBe(true);
    expect(await visibleMessages(context.sqs, queueUrl)).toBe(0);

    await context.orm.em.getConnection().execute(`
      create sequence ${table(context.schema, 'falha_publicacao_outbox_seq')} start 1;
      create function ${table(context.schema, 'falha_publicacao_outbox')}()
      returns trigger language plpgsql as $$
      begin
        if old."published_at" is null and new."published_at" is not null
          and nextval('"${context.schema}"."falha_publicacao_outbox_seq"'::regclass) = 1 then
          raise exception using errcode = 'P0001',
            message = 'Falha após envio ao SQS para validar recuperação';
        end if;
        return new;
      end;
      $$;
      create trigger "falha_publicacao_outbox_uma_vez"
      before update on ${table(context.schema, 'outbox_messages')}
      for each row execute function ${table(context.schema, 'falha_publicacao_outbox')}();
    `);

    const firstAttempt = await firstPublisher.executeBatch();
    expect(firstAttempt.claimed).toBe(1);
    expect(firstAttempt.published).toBe(0);
    expect(firstAttempt.failures[0]?.phase).toBe('mark-published');
    await waitFor(async () => (await visibleMessages(context.sqs, queueUrl!)) === 1,
      'primeiro evento confirmado pelo SQS');

    const firstEventId = initialRows[0]?.id as string;
    const claimedRows = await context.orm.em.getConnection().execute(
      `select "published_at" is null as "pending",
              "locked_until" > now() as "leased"
       from ${table(context.schema, 'outbox_messages')} where "id" = ?`,
      [firstEventId],
    );
    expect(claimedRows).toEqual([{ pending: true, leased: true }]);

    await context.orm.em.getConnection().execute(`
      drop trigger "falha_publicacao_outbox_uma_vez"
        on ${table(context.schema, 'outbox_messages')};
      drop function ${table(context.schema, 'falha_publicacao_outbox')}();
      drop sequence ${table(context.schema, 'falha_publicacao_outbox_seq')};
    `);
    await context.orm.em.getConnection().execute(
      `update ${table(context.schema, 'outbox_messages')}
       set "locked_until" = now() - interval '1 second' where "id" = ?`,
      [firstEventId],
    );

    await publishUntilIdle([firstPublisher, secondPublisher]);
    const finalRows = await context.orm.em.getConnection().execute(
      `select "id"::text as "id", "sequence_number" as "sequenceNumber",
              "event_type" as "eventType", "published_at" is not null as "published",
              "attempts" as "attempts", "lock_token" is null as "unlocked"
       from ${table(context.schema, 'outbox_messages')} order by "sequence_number"`,
    );
    expect(finalRows).toEqual([
      {
        id: initialRows[0]?.id,
        sequenceNumber: 1,
        eventType: 'WagerTransactionProcessed',
        published: true,
        attempts: 0,
        unlocked: true,
      },
      {
        id: initialRows[1]?.id,
        sequenceNumber: 2,
        eventType: 'WalletBalanceChanged',
        published: true,
        attempts: 0,
        unlocked: true,
      },
    ]);
    await waitFor(async () => (await visibleMessages(context.sqs, queueUrl!)) === 2,
      'os dois eventos financeiros na fila');

    const messages = await readPublishedEvents(context, queueUrl);
    expect(messages.map((message) => {
      const event = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
      return event.eventType;
    })).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(messages.map((message) => {
      const event = JSON.parse(message.Body ?? '{}') as {
        readonly eventId?: string;
        readonly data?: { readonly money?: { readonly amount?: unknown } };
      };
      expect(typeof event.data?.money?.amount).toBe('string');
      return event.eventId;
    })).toEqual([initialRows[0]?.id, initialRows[1]?.id]);
    await deleteReceivedEvents(context, queueUrl, messages);
  } finally {
    firstSqsPublisher.destroy();
    secondSqsPublisher.destroy();
    if (queueUrl) {
      await context.sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    await context.close();
  }
});

test('falha de publicação agenda retry no PostgreSQL e entrega após a fila voltar', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const queueName = `wager-events-recovery-${suffix}.fifo`;
  const context = await createContext(queueName);
  const sqsPublisher = new SqsOutboxEventPublisher(context.config);
  const publisher = new PublishOutboxMessages(
    new PostgresOutboxPublishing(context.orm, context.schema),
    sqsPublisher,
  );
  let queueUrl: string | undefined;
  let worker: OutboxPublisherWorker | undefined;
  let workerStopped = false;

  try {
    await openWallet(context);
    const failedAttempt = await publisher.executeBatch();
    expect(failedAttempt.claimed).toBe(1);
    expect(failedAttempt.retriesScheduled).toBe(1);
    expect(failedAttempt.failures[0]).toMatchObject({
      phase: 'send',
      attempt: 1,
      retryDelaySeconds: 1,
      retryScheduled: true,
    });

    const retryRows = await context.orm.em.getConnection().execute(
      `select "attempts", "next_attempt_at" > now() as "backoff_active",
              "lock_token" is null as "unlocked", "published_at" is null as "pending"
       from ${table(context.schema, 'outbox_messages')} order by "sequence_number"`,
    );
    expect(retryRows).toEqual([
      { attempts: 1, backoff_active: true, unlocked: true, pending: true },
      { attempts: 0, backoff_active: false, unlocked: true, pending: true },
    ]);

    queueUrl = await createEventQueue(context.sqs, queueName);
    await context.orm.em.getConnection().execute(
      `update ${table(context.schema, 'outbox_messages')}
       set "next_attempt_at" = now() - interval '1 second'`,
    );
    worker = new OutboxPublisherWorker(publisher, sqsPublisher);
    worker.onModuleInit();
    await waitFor(async () => {
      const rows = await context.orm.em.getConnection().execute(
        `select count(*)::text as "publishedCount"
         from ${table(context.schema, 'outbox_messages')}
         where "published_at" is not null`,
      );
      return rows[0]?.publishedCount === '2';
    }, 'publicação dos eventos pelo worker');
    await worker.onModuleDestroy();
    workerStopped = true;

    const publishedRows = await context.orm.em.getConnection().execute(
      `select "published_at" is not null as "published", "attempts" as "attempts"
       from ${table(context.schema, 'outbox_messages')} order by "sequence_number"`,
    );
    expect(publishedRows).toEqual([
      { published: true, attempts: 1 },
      { published: true, attempts: 0 },
    ]);
    await waitFor(async () => (await visibleMessages(context.sqs, queueUrl!)) === 2,
      'eventos publicados após a recuperação da fila');

    const messages = await readPublishedEvents(context, queueUrl);
    expect(messages).toHaveLength(2);
    await deleteReceivedEvents(context, queueUrl, messages);
  } finally {
    if (worker && !workerStopped) {
      await worker.onModuleDestroy();
    } else if (!worker) {
      sqsPublisher.destroy();
    }
    if (queueUrl) {
      await context.sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
    await context.close();
  }
});
