/**
 * Esta página valida recebimento, inbox, ack e DLQ com SQS LocalStack real.
 * Assinatura: Leonardo de Souza da Luz
 */
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { expect, test } from 'bun:test';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { ProcessWager } from '../../../src/application/wagering/process-wager.js';
import { loadApplicationConfig } from '../../../src/config/application-config.js';
import { createMikroOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.options.js';
import { PostgresWagerPersistence } from '../../../src/infrastructure/persistence/postgres-wager-persistence.js';
import { WagerSqsConsumer } from '../../../src/infrastructure/messaging/wager-sqs-consumer.js';

function table(schema: string, name: string): string {
  return `"${schema}"."${name}"`;
}

async function executeInTransaction(
  entityManager: EntityManager,
  query: string,
  params: unknown[] = [],
): Promise<unknown[]> {
  return entityManager.getConnection().execute(
    query,
    params,
    'all',
    entityManager.getTransactionContext(),
  );
}

async function seedWallet(
  orm: MikroORM,
  schema: string,
  walletId: string,
  playerId: string,
): Promise<void> {
  await orm.em.transactional(async (entityManager) => {
    const openingId = randomUUID();
    await executeInTransaction(
      entityManager,
      `insert into ${table(schema, 'wallets')} (
        "id", "player_id", "currency", "balance", "version"
      ) values (?, ?, 'BRL', '100.00', 1)`,
      [walletId, playerId],
    );
    await executeInTransaction(
      entityManager,
      `insert into ${table(schema, 'wager_transactions')} (
        "id", "provider_id", "external_transaction_id", "idempotency_key",
        "payload_hash", "wallet_id", "player_id", "currency", "round_id",
        "game_id", "kind", "amount", "status", "created_at"
      ) values (?, 'interno', ?, ?, 'saldo-inicial', ?, ?, 'BRL', 'abertura',
        'interno', 'OPENING', '100.00', 'PENDING', now())`,
      [openingId, `abertura-${walletId}`, `abertura-${walletId}`, walletId, playerId],
    );
    await executeInTransaction(
      entityManager,
      `insert into ${table(schema, 'wallet_ledger_entries')} (
        "id", "wallet_id", "transaction_id", "direction", "amount", "currency",
        "balance_before", "balance_after"
      ) values (?, ?, ?, 'CREDIT', '100.00', 'BRL', '0.00', '100.00')`,
      [randomUUID(), walletId, openingId],
    );
    await executeInTransaction(
      entityManager,
      `update ${table(schema, 'wager_transactions')}
       set "status" = 'PROCESSED', "processed_at" = now(),
           "result_balance" = '100.00', "result_currency" = 'BRL'
       where "id" = ?`,
      [openingId],
    );
  });
}

async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Tempo esgotado aguardando ${description}.`);
}

test('consumidor SQS usa inbox, espera commit, confirma redelivery e envia payload inválido à DLQ', async () => {
  const baseConfig = loadApplicationConfig();
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `teste_sqs_${suffix}`;
  const playerId = `jogador-${randomUUID()}`;
  const walletId = randomUUID();
  const sourceQueueName = `wager-test-${suffix}.fifo`;
  const deadLetterQueueName = `wager-test-dlq-${suffix}.fifo`;
  const config = {
    ...baseConfig,
    sqs: {
      ...baseConfig.sqs,
      queueName: sourceQueueName,
      deadLetterQueueName,
    },
  };
  const administrator = await MikroORM.init(createMikroOrmOptions(baseConfig));
  let orm: MikroORM | undefined;
  const sqs = new SQSClient({
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    credentials: {
      accessKeyId: config.sqs.accessKeyId,
      secretAccessKey: config.sqs.secretAccessKey,
    },
  });
  let sourceQueueUrl: string | undefined;
  let deadLetterQueueUrl: string | undefined;
  let consumer: WagerSqsConsumer | undefined;

  try {
    await administrator.em.getConnection().execute(`create schema "${schema}"`);
    orm = await MikroORM.init(createMikroOrmOptions(baseConfig, schema));
    await orm.migrator.up();
    await seedWallet(orm, schema, walletId, playerId);

    const deadLetterQueue = await sqs.send(new CreateQueueCommand({
      QueueName: deadLetterQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    deadLetterQueueUrl = deadLetterQueue.QueueUrl;
    if (!deadLetterQueueUrl) {
      throw new Error('LocalStack não retornou a URL da DLQ de teste.');
    }
    const deadLetterAttributes = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: deadLetterQueueUrl,
      AttributeNames: ['QueueArn'],
    }));
    const deadLetterArn = deadLetterAttributes.Attributes?.QueueArn;
    if (!deadLetterArn) {
      throw new Error('LocalStack não retornou o ARN da DLQ de teste.');
    }
    const sourceQueue = await sqs.send(new CreateQueueCommand({
      QueueName: sourceQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: deadLetterArn,
          maxReceiveCount: '2',
        }),
      },
    }));
    sourceQueueUrl = sourceQueue.QueueUrl;
    if (!sourceQueueUrl) {
      throw new Error('LocalStack não retornou a URL da fila de teste.');
    }

    consumer = new WagerSqsConsumer(
      config,
      new ProcessWager(new PostgresWagerPersistence(orm, schema)),
    );
    consumer.onModuleInit();

    const messageBody = JSON.stringify({
      messageId: `mensagem-${suffix}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provedor-localstack',
        externalTransactionId: `aposta-${suffix}`,
        idempotencyKey: `provedor-localstack:aposta-${suffix}`,
        playerId,
        walletId,
        roundId: 'rodada-localstack',
        gameId: 'jogo-localstack',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    });
    await sqs.send(new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: messageBody,
      MessageGroupId: walletId,
      MessageDeduplicationId: `primeiro-${suffix}`,
    }));

    await waitFor(async () => {
      const inboxRows = await orm!.em.getConnection().execute(
        `select "processed_at" is not null as "processed"
         from ${table(schema, 'inbox_messages')} where "message_id" = ?`,
        [`mensagem-${suffix}`],
      );
      const walletRows = await orm!.em.getConnection().execute(
        `select "balance"::text as "balance" from ${table(schema, 'wallets')}
         where "id" = ?`,
        [walletId],
      );
      return inboxRows[0]?.processed === true && walletRows[0]?.balance === '75.00';
    }, 'commit financeiro e inbox');

    await sqs.send(new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: messageBody,
      MessageGroupId: walletId,
      MessageDeduplicationId: `redelivery-${suffix}`,
    }));
    await waitFor(async () => {
      const attributes = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: sourceQueueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }));
      return attributes.Attributes?.ApproximateNumberOfMessages === '0' &&
        attributes.Attributes?.ApproximateNumberOfMessagesNotVisible === '0';
    }, 'ack da redelivery duplicada');

    const retryMessageId = `mensagem-retry-${suffix}`;
    const retryBody = JSON.stringify({
      messageId: retryMessageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provedor-localstack',
        externalTransactionId: `aposta-retry-${suffix}`,
        idempotencyKey: `provedor-localstack:aposta-retry-${suffix}`,
        playerId,
        walletId,
        roundId: 'rodada-localstack',
        gameId: 'jogo-localstack',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      },
    });
    await orm.em.getConnection().execute(`
      create sequence ${table(schema, 'falha_transitoria_sqs_seq')};
      create function ${table(schema, 'falha_transitoria_sqs')}() returns trigger
      language plpgsql as $$
      begin
        if new."event_type" = 'WagerTransactionProcessed'
          and nextval('"${schema}"."falha_transitoria_sqs_seq"'::regclass) = 1 then
          raise exception using errcode = '08006', message = 'Falha transitória induzida';
        end if;
        return new;
      end;
      $$;
      create trigger "falha_transitoria_sqs"
      before insert on ${table(schema, 'outbox_messages')}
      for each row execute function ${table(schema, 'falha_transitoria_sqs')}();
    `);
    await sqs.send(new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: retryBody,
      MessageGroupId: walletId,
      MessageDeduplicationId: `retry-${suffix}`,
    }));
    await waitFor(async () => {
      const transactionRows = await orm!.em.getConnection().execute(
        `select "status" from ${table(schema, 'wager_transactions')}
         where "external_transaction_id" = ?`,
        [`aposta-retry-${suffix}`],
      );
      const inboxRows = await orm!.em.getConnection().execute(
        `select "processed_at" is not null as "processed"
         from ${table(schema, 'inbox_messages')} where "message_id" = ?`,
        [retryMessageId],
      );
      return transactionRows[0]?.status === 'PROCESSED' &&
        inboxRows[0]?.processed === true;
    }, 'processamento após uma falha transitória');
    const retryCountRows = await orm.em.getConnection().execute(
      `select "last_value" as "attempts"
       from ${table(schema, 'falha_transitoria_sqs_seq')}`,
    );
    await orm.em.getConnection().execute(`
      drop trigger "falha_transitoria_sqs" on ${table(schema, 'outbox_messages')};
      drop function ${table(schema, 'falha_transitoria_sqs')}();
      drop sequence ${table(schema, 'falha_transitoria_sqs_seq')};
    `);
    expect(retryCountRows).toEqual([{ attempts: '2' }]);

    const financialRows = await orm.em.getConnection().execute(
      `select wallets."balance"::text as "balance", wallets."version",
              count(ledger."id")::text as "debitEntries"
       from ${table(schema, 'wallets')} as wallets
       left join ${table(schema, 'wallet_ledger_entries')} as ledger
         on ledger."wallet_id" = wallets."id" and ledger."direction" = 'DEBIT'
       where wallets."id" = ?
       group by wallets."balance", wallets."version"`,
      [walletId],
    );
    expect(financialRows).toEqual([{
      balance: '70.00',
      version: 3,
      debitEntries: '2',
    }]);

    const permanentMessageId = `mensagem-dlq-${suffix}`;
    const permanentBody = JSON.stringify({
      messageId: permanentMessageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provedor-localstack',
        externalTransactionId: `aposta-dlq-${suffix}`,
        idempotencyKey: `provedor-localstack:aposta-dlq-${suffix}`,
        playerId,
        walletId,
        roundId: 'rodada-localstack',
        gameId: 'jogo-localstack',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
    });
    await orm.em.getConnection().execute(`
      create function ${table(schema, 'falha_permanente_sqs')}() returns trigger
      language plpgsql as $$
      begin
        raise exception using errcode = 'P0001', message = 'Falha permanente induzida';
      end;
      $$;
      create trigger "falha_permanente_sqs"
      before insert on ${table(schema, 'outbox_messages')}
      for each row execute function ${table(schema, 'falha_permanente_sqs')}();
    `);
    await sqs.send(new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: permanentBody,
      MessageGroupId: walletId,
      MessageDeduplicationId: `permanent-${suffix}`,
    }));
    await waitFor(async () => {
      const attributes = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: deadLetterQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      return attributes.Attributes?.ApproximateNumberOfMessages === '1';
    }, 'redrive após falhas permanentes na DLQ');
    await orm.em.getConnection().execute(`
      drop trigger "falha_permanente_sqs" on ${table(schema, 'outbox_messages')};
      drop function ${table(schema, 'falha_permanente_sqs')}();
    `);

    const redrivenMessage = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: deadLetterQueueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
    }));
    const redrivenBody = redrivenMessage.Messages?.[0]?.Body;
    if (!redrivenBody) {
      throw new Error('A mensagem excedida não chegou à DLQ.');
    }
    expect(JSON.parse(redrivenBody).messageId).toBe(permanentMessageId);
    const redrivenReceipt = redrivenMessage.Messages?.[0]?.ReceiptHandle;
    if (!redrivenReceipt) {
      throw new Error('A mensagem redirecionada à DLQ não trouxe receipt handle.');
    }
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: deadLetterQueueUrl,
      ReceiptHandle: redrivenReceipt,
    }));

    await sqs.send(new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: '{',
      MessageGroupId: walletId,
      MessageDeduplicationId: `payload-invalido-${suffix}`,
    }));
    await sqs.send(new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: '{',
      MessageGroupId: walletId,
      MessageDeduplicationId: `payload-invalido-duplicado-${suffix}`,
    }));
    await waitFor(async () => {
      const attributes = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: deadLetterQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      return attributes.Attributes?.ApproximateNumberOfMessages === '2';
    }, 'duas mensagens inválidas iguais na DLQ');

    const deadLetterMessage = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: deadLetterQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }));
    expect(deadLetterMessage.Messages?.map((item) => item.Body)).toEqual(['{', '{']);
    for (const item of deadLetterMessage.Messages ?? []) {
      if (!item.ReceiptHandle) {
        throw new Error('A mensagem de teste na DLQ não trouxe receipt handle.');
      }
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        ReceiptHandle: item.ReceiptHandle,
      }));
    }
  } finally {
    if (consumer) {
      await consumer.onModuleDestroy();
    }
    if (sourceQueueUrl) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: sourceQueueUrl }));
    }
    if (deadLetterQueueUrl) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }));
    }
    if (orm) {
      await orm.close(true);
    }
    await administrator.em.getConnection().execute(
      `drop schema if exists "${schema}" cascade`,
    );
    await administrator.close(true);
    sqs.destroy();
  }
});
