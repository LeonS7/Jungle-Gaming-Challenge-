/**
 * Esta página valida concorrência, métricas e recuperação em três processos Bun reais.
 * Assinatura: Leonardo de Souza da Luz
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWager } from '../../../src/application/wagering/process-wager.js';
import { loadApplicationConfig } from '../../../src/config/application-config.js';
import { Money } from '../../../src/domain/money/money.js';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction.js';
import { PostgresWagerPersistence } from '../../../src/infrastructure/persistence/postgres-wager-persistence.js';
import { createMikroOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.options.js';

interface RunningInstance {
  readonly port: number;
  readonly process: ChildProcess;
  readonly output: string[];
  readonly exited: Promise<void>;
}

interface WalletHttpResponse {
  readonly id?: string;
  readonly balance?: { readonly amount: string; readonly currency: string };
}

interface WagerHttpResponse {
  readonly transactionId?: string;
  readonly status?: string;
  readonly balance?: { readonly amount: string; readonly currency: string } | null;
  readonly idempotentReplay?: boolean;
}

function table(schema: string, name: string): string {
  return '"' + schema + '"."' + name + '"';
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Não foi possível reservar uma porta HTTP para o teste.');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function startInstance(port: number, schema: string): RunningInstance {
  const output: string[] = [];
  const child = spawn(process.execPath, ['run', 'src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_PORT: String(port),
      DATABASE_SCHEMA: schema,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk: Uint8Array): void => {
    output.push(Buffer.from(chunk).toString('utf8'));
    while (output.join('').length > 8_000) {
      output.shift();
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  return { port, process: child, output, exited };
}

async function waitUntilReady(instance: RunningInstance): Promise<void> {
  const deadline = Date.now() + 12_000;
  const url = 'http://127.0.0.1:' + instance.port + '/health/ready';
  while (Date.now() < deadline) {
    if (instance.process.exitCode !== null || instance.process.signalCode !== null) {
      throw new Error(
        'Uma instância encerrou durante a inicialização. ' + instance.output.join(''),
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // A porta pode ainda não estar ouvindo enquanto o NestJS inicializa.
    }
    await wait(100);
  }
  throw new Error(
    'A instância não ficou pronta em 12 segundos. ' + instance.output.join(''),
  );
}

async function stopInstance(instance: RunningInstance): Promise<void> {
  if (instance.process.exitCode !== null || instance.process.signalCode !== null) {
    return;
  }
  instance.process.kill('SIGTERM');
  const shutdownDeadline = Date.now() + 8_000;
  while (
    Date.now() < shutdownDeadline &&
    instance.process.exitCode === null &&
    instance.process.signalCode === null
  ) {
    await wait(50);
  }
  if (instance.process.exitCode === null && instance.process.signalCode === null) {
    instance.process.kill('SIGKILL');
    await Promise.race([instance.exited, wait(2_000)]);
  }
}

async function stopInstances(instances: readonly RunningInstance[]): Promise<void> {
  await Promise.all(instances.map(stopInstance));
}

function metricValue(
  body: string,
  metric: string,
  labelName?: string,
  labelValue?: string,
): number {
  const series = labelName && labelValue
    ? metric + '{' + labelName + '="' + labelValue + '"}'
    : metric;
  const line = body.split('\n').find((item) => item.startsWith(series + ' '));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

async function submit(
  instance: RunningInstance,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ readonly response: Response; readonly body: WagerHttpResponse }> {
  const response = await fetch(
    'http://127.0.0.1:' + instance.port + '/wagering/transactions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  return {
    response,
    body: await response.json() as WagerHttpResponse,
  };
}

async function waitForPendingResolution(
  orm: MikroORM,
  schema: string,
  transactionId: string,
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await orm.em.getConnection().execute(
      `select "status" from ${table(schema, 'wager_transactions')} where "id" = ?`,
      [transactionId],
    );
    if (rows[0]?.status === 'PROCESSED' || rows[0]?.status === 'REJECTED') {
      return rows[0]?.status === 'PROCESSED';
    }
    await wait(100);
  }
  return false;
}

test('três processos dividem idempotência e recuperam referências pendentes após reinício', async () => {
  const config = loadApplicationConfig();
  const schema = 'teste_instancias_' + randomUUID().replaceAll('-', '');
  const administrator = await MikroORM.init(createMikroOrmOptions(config));
  let orm: MikroORM | undefined;
  let instances: RunningInstance[] = [];
  const ports = await Promise.all([
    availablePort(),
    availablePort(),
    availablePort(),
  ]);

  try {
    await administrator.em.getConnection().execute('create schema "' + schema + '"');
    orm = await MikroORM.init(createMikroOrmOptions(config, schema));
    await orm.migrator.up();
    instances = ports.map((port) => startInstance(port, schema));
    await Promise.all(instances.map(waitUntilReady));

    const playerId = randomUUID();
    const walletResponse = await fetch(
      'http://127.0.0.1:' + ports[0] + '/wallets',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      },
    );
    const wallet = await walletResponse.json() as WalletHttpResponse;
    expect(walletResponse.status).toBe(201);
    expect(wallet.id).toBeDefined();

    const request = {
      providerId: 'provedor-tres-instancias',
      externalTransactionId: 'aposta-idempotente-tres-instancias-' + randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: 'rodada-tres-instancias',
      gameId: 'jogo-tres-instancias',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };
    const idempotencyKey = 'chave-tres-instancias-' + randomUUID();
    const concurrentResponses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        submit(instances[index % instances.length]!, request, idempotencyKey),
      ),
    );
    expect(concurrentResponses.every(({ response }) => response.status === 200)).toBe(true);
    expect(concurrentResponses.filter(({ body }) => body.idempotentReplay === false))
      .toHaveLength(1);
    expect(new Set(concurrentResponses.map(({ body }) => body.transactionId)).size).toBe(1);
    expect(concurrentResponses.every(({ body }) => body.balance?.amount === '20.00'))
      .toBe(true);

    const initialWalletRows = await orm.em.getConnection().execute(
      `select wallet."balance"::text as "balance",
              coalesce(sum(case ledger."direction"
                when 'CREDIT' then ledger."amount"
                when 'DEBIT' then -ledger."amount"
                else 0::numeric
              end), 0::numeric)::numeric(30, 2)::text as "ledgerBalance",
              count(ledger."id")::text as "entryCount"
       from ${table(schema, 'wallets')} wallet
       left join ${table(schema, 'wallet_ledger_entries')} ledger
         on ledger."wallet_id" = wallet."id"
       where wallet."id" = ?
       group by wallet."id"`,
      [wallet.id],
    );
    expect(initialWalletRows).toEqual([{
      balance: '20.00',
      ledgerBalance: '20.00',
      entryCount: '2',
    }]);

    const firstMetrics = await Promise.all(instances.map(async (instance) =>
      (await fetch('http://127.0.0.1:' + instance.port + '/metrics')).text(),
    ));
    expect(firstMetrics.reduce(
      (total, body) => total + metricValue(
        body,
        'wagering_duplicates_total',
        'source',
        'idempotency',
      ),
      0,
    )).toBe(49);

    const referenceExternalTransactionId = 'aposta-referencia-apos-reinicio-' + randomUUID();
    const pendingResponse = await submit(
      instances[0]!,
      {
        ...request,
        externalTransactionId: 'premio-pendente-apos-reinicio-' + randomUUID(),
        kind: 'WIN',
        referenceExternalTransactionId,
        money: { amount: '0.50', currency: 'BRL' },
      },
      'chave-premio-pendente-' + randomUUID(),
    );
    expect(pendingResponse.response.status).toBe(202);
    expect(pendingResponse.body.status).toBe('PENDING_REFERENCE');
    const pendingTransactionId = pendingResponse.body.transactionId;
    if (!pendingTransactionId || !wallet.id) {
      throw new Error('A resposta HTTP não trouxe os identificadores esperados.');
    }

    await stopInstances(instances);
    instances = [];

    const referenceBet = await new ProcessWager(
      new PostgresWagerPersistence(orm, schema),
    ).execute({
      providerId: request.providerId,
      externalTransactionId: referenceExternalTransactionId,
      idempotencyKey: 'chave-aposta-referencia-' + randomUUID(),
      payloadHash: 'hash-aposta-referencia-' + randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '1.00', currency: 'BRL' }),
    });
    await orm.em.getConnection().execute(
      `update ${table(schema, 'wager_transactions')}
       set "reference_next_attempt_at" = now() - interval '1 second'
       where "id" = ?`,
      [pendingTransactionId],
    );

    instances = ports.map((port) => startInstance(port, schema));
    await Promise.all(instances.map(waitUntilReady));
    expect(await waitForPendingResolution(orm, schema, pendingTransactionId)).toBe(true);

    const recoveredRows = await orm.em.getConnection().execute(
      `select "status", "reference_transaction_id" as "referenceTransactionId",
              "result_balance"::text as "resultBalance"
       from ${table(schema, 'wager_transactions')} where "id" = ?`,
      [pendingTransactionId],
    );
    const finalWalletRows = await orm.em.getConnection().execute(
      `select wallet."balance"::text as "balance",
              coalesce(sum(case ledger."direction"
                when 'CREDIT' then ledger."amount"
                when 'DEBIT' then -ledger."amount"
                else 0::numeric
              end), 0::numeric)::numeric(30, 2)::text as "ledgerBalance"
       from ${table(schema, 'wallets')} wallet
       left join ${table(schema, 'wallet_ledger_entries')} ledger
         on ledger."wallet_id" = wallet."id"
       where wallet."id" = ?
       group by wallet."id"`,
      [wallet.id],
    );
    const recoveredEvents = await orm.em.getConnection().execute(
      `select "event_type" as "eventType", "sequence_number" as "sequenceNumber"
       from ${table(schema, 'outbox_messages')}
       where "transaction_id" = ? order by "sequence_number"`,
      [pendingTransactionId],
    );
    const restartMetrics = await Promise.all(instances.map(async (instance) =>
      (await fetch('http://127.0.0.1:' + instance.port + '/metrics')).text(),
    ));

    expect(recoveredRows).toEqual([{
      status: 'PROCESSED',
      referenceTransactionId: referenceBet.transactionId,
      resultBalance: '19.50',
    }]);
    expect(finalWalletRows).toEqual([{
      balance: '19.50',
      ledgerBalance: '19.50',
    }]);
    expect(recoveredEvents).toEqual([
      { eventType: 'WagerTransactionPendingReference', sequenceNumber: 1 },
      { eventType: 'WagerTransactionProcessed', sequenceNumber: 2 },
      { eventType: 'WalletBalanceChanged', sequenceNumber: 3 },
    ]);
    expect(restartMetrics.every((body) =>
      body.includes('sqs_dlq_visible_messages ')
      && body.includes('outbox_lag_seconds ')
      && body.includes('wagering_wallet_lock_acquisition_seconds_count')
      && body.includes('wagering_processing_duration_seconds_count'),
    )).toBe(true);
  } finally {
    await stopInstances(instances);
    if (orm) {
      await orm.close(true);
    }
    await administrator.em.getConnection().execute(
      'drop schema if exists "' + schema + '" cascade',
    );
    await administrator.close(true);
  }
});
