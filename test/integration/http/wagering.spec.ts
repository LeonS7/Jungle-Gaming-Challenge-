/**
 * Esta página verifica o contrato HTTP de BET, WIN e LOSS com NestJS e PostgreSQL reais.
 * Assinatura: Leonardo de Souza da Luz
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { expect, test } from 'bun:test';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../../../src/app.module.js';
import { loadApplicationConfig } from '../../../src/config/application-config.js';
import { createMikroOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.options.js';

interface HttpContext {
  readonly baseUrl: string;
  readonly orm: MikroORM;
  readonly schema: string;
  readonly playerId: string;
  readonly walletId: string;
}

interface HttpResponseBody {
  readonly id?: string;
  readonly playerId?: string;
  readonly transactionId?: string;
  readonly status?: string;
  readonly balance?: { readonly amount: string; readonly currency: string };
  readonly idempotentReplay?: boolean;
  readonly failureCode?: string;
  readonly code?: string;
  readonly version?: number;
}

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
    const transactionId = randomUUID();
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
        "id", "provider_id", "external_transaction_id", "idempotency_key", "payload_hash",
        "wallet_id", "player_id", "currency", "round_id", "game_id", "kind", "amount",
        "status", "created_at"
      ) values (?, 'interno', ?, ?, 'saldo-inicial', ?, ?, 'BRL', 'abertura', 'interno', 'OPENING', '100.00', 'PENDING', now())`,
      [
        transactionId,
        `abertura-${walletId}`,
        `abertura-${walletId}`,
        walletId,
        playerId,
      ],
    );
    await executeInTransaction(
      entityManager,
      `insert into ${table(schema, 'wallet_ledger_entries')} (
        "id", "wallet_id", "transaction_id", "direction", "amount", "currency",
        "balance_before", "balance_after"
      ) values (?, ?, ?, 'CREDIT', '100.00', 'BRL', '0.00', '100.00')`,
      [randomUUID(), walletId, transactionId],
    );
    await executeInTransaction(
      entityManager,
      `update ${table(schema, 'wager_transactions')}
       set "status" = 'PROCESSED', "processed_at" = now(),
           "result_balance" = '100.00', "result_currency" = 'BRL'
       where "id" = ?`,
      [transactionId],
    );
  });
}

async function withHttpApplication(
  operation: (context: HttpContext) => Promise<void>,
): Promise<void> {
  const config = loadApplicationConfig();
  const schema = `teste_http_${randomUUID().replaceAll('-', '')}`;
  const playerId = `jogador-${randomUUID()}`;
  const walletId = randomUUID();
  const administrator = await MikroORM.init(createMikroOrmOptions(config));
  let scopedOrm: MikroORM | undefined;
  let application: INestApplication | undefined;

  try {
    await administrator.em.getConnection().execute(`create schema "${schema}"`);
    scopedOrm = await MikroORM.init(createMikroOrmOptions(config, schema));
    await scopedOrm.migrator.up();
    await seedWallet(scopedOrm, schema, walletId, playerId);

    application = await NestFactory.create(AppModule.register(config, schema), {
      logger: false,
    });
    await application.listen(0, '127.0.0.1');
    await operation({
      baseUrl: await application.getUrl(),
      orm: scopedOrm,
      schema,
      playerId,
      walletId,
    });
  } finally {
    if (application) {
      await application.close();
    }
    if (scopedOrm) {
      await scopedOrm.close(true);
    }
    await administrator.em.getConnection().execute(
      `drop schema if exists "${schema}" cascade`,
    );
    await administrator.close(true);
  }
}

function createRequest(
  playerId: string,
  walletId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerId: 'provedor-http',
    externalTransactionId: 'aposta-http-1',
    playerId,
    walletId,
    roundId: 'rodada-http-1',
    gameId: 'jogo-http-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

async function submit(
  baseUrl: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function createWallet(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST BET processa 50 repetições e devolve resposta idempotente', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema, playerId, walletId }) => {
    const request = createRequest(playerId, walletId);
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submit(baseUrl, request, 'chave-http-50')),
    );
    const bodies = (await Promise.all(
      responses.map((response) => response.json() as Promise<HttpResponseBody>),
    ));
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const transactionRows = await orm.em.getConnection().execute(
      `select "id", "status" from ${table(schema, 'wager_transactions')} where "kind" = 'BET'`,
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select "amount"::text as "amount" from ${table(schema, 'wallet_ledger_entries')}
       where "wallet_id" = ? and "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'BET'
       )`,
      [walletId],
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(bodies.filter((body) => body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.transactionId)).size).toBe(1);
    expect(bodies.every((body) => body.balance?.amount === '90.00')).toBe(true);
    expect(walletRows).toEqual([{ balance: '90.00', version: 2 }]);
    expect(transactionRows).toHaveLength(1);
    expect(ledgerRows).toEqual([{ amount: '10.00' }]);

    const changedPayload = await submit(
      baseUrl,
      createRequest(playerId, walletId, { money: { amount: '11.00', currency: 'BRL' } }),
      'chave-http-50',
    );
    const conflict = await changedPayload.json() as HttpResponseBody;
    expect(changedPayload.status).toBe(409);
    expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT');

    const providerConflictResponse = await submit(
      baseUrl,
      request,
      'chave-identificador-externo-duplicado',
    );
    const providerConflict = await providerConflictResponse.json() as HttpResponseBody;
    expect(providerConflictResponse.status).toBe(409);
    expect(providerConflict.code).toBe('PROVIDER_TRANSACTION_CONFLICT');
  });
});

test('POST WIN credita uma vez e mantém referências fora do escopo atual', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema, playerId, walletId }) => {
    const request = createRequest(playerId, walletId, {
      externalTransactionId: 'vitoria-http-1',
      kind: 'WIN',
    });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submit(baseUrl, request, 'chave-vitoria-http-1')),
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<HttpResponseBody>),
    );
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const winRows = await orm.em.getConnection().execute(
      `select "status", "result_balance"::text as "resultBalance"
       from ${table(schema, 'wager_transactions')} where "kind" = 'WIN'`,
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select "direction", "amount"::text as "amount",
              "balance_before"::text as "balanceBefore", "balance_after"::text as "balanceAfter"
       from ${table(schema, 'wallet_ledger_entries')}
       where "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'WIN'
       )`,
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(bodies.filter((body) => body.idempotentReplay === false)).toHaveLength(1);
    expect(bodies.every((body) => body.status === 'PROCESSED')).toBe(true);
    expect(bodies.every((body) => body.balance?.amount === '110.00')).toBe(true);
    expect(new Set(bodies.map((body) => body.transactionId)).size).toBe(1);
    expect(walletRows).toEqual([{ balance: '110.00', version: 2 }]);
    expect(winRows).toEqual([{ status: 'PROCESSED', resultBalance: '110.00' }]);
    expect(ledgerRows).toEqual([{
      direction: 'CREDIT',
      amount: '10.00',
      balanceBefore: '100.00',
      balanceAfter: '110.00',
    }]);

    const referencedWin = await submit(
      baseUrl,
      createRequest(playerId, walletId, {
        externalTransactionId: 'vitoria-http-referenciada',
        kind: 'WIN',
        referenceExternalTransactionId: 'aposta-http-1',
      }),
      'chave-vitoria-referenciada',
    );
    const referencedWinBody = await referencedWin.json() as HttpResponseBody;
    expect(referencedWin.status).toBe(400);
    expect(referencedWinBody.code).toBe('INVALID_REQUEST');
  });
});

test('POST BET diferencia entrada inválida e operação ainda não suportada', async () => {
  await withHttpApplication(async ({ baseUrl, playerId, walletId }) => {
    const missingKey = await submit(baseUrl, createRequest(playerId, walletId));
    const missingKeyBody = await missingKey.json() as HttpResponseBody;
    expect(missingKey.status).toBe(400);
    expect(missingKeyBody.code).toBe('INVALID_REQUEST');

    const invalidAmount = await submit(
      baseUrl,
      createRequest(playerId, walletId, { money: { amount: 10, currency: 'BRL' } }),
      'chave-invalida-1',
    );
    const invalidAmountBody = await invalidAmount.json() as HttpResponseBody;
    expect(invalidAmount.status).toBe(400);
    expect(invalidAmountBody.code).toBe('INVALID_REQUEST');

    const currencyMismatch = await submit(
      baseUrl,
      createRequest(playerId, walletId, { money: { amount: '10.00', currency: 'EUR' } }),
      'chave-moeda-divergente',
    );
    const currencyMismatchBody = await currencyMismatch.json() as HttpResponseBody;
    expect(currencyMismatch.status).toBe(422);
    expect(currencyMismatchBody.code).toBe('CURRENCY_MISMATCH');

    const unsupportedKind = await submit(
      baseUrl,
      createRequest(playerId, walletId, { kind: 'REFUND' }),
      'chave-nao-suportada',
    );
    const unsupportedKindBody = await unsupportedKind.json() as HttpResponseBody;
    expect(unsupportedKind.status).toBe(501);
    expect(unsupportedKindBody.code).toBe('UNSUPPORTED_TRANSACTION_KIND');

    const missingWallet = await submit(
      baseUrl,
      createRequest(playerId, randomUUID()),
      'chave-carteira-inexistente',
    );
    const missingWalletBody = await missingWallet.json() as HttpResponseBody;
    expect(missingWallet.status).toBe(404);
    expect(missingWalletBody.code).toBe('WALLET_NOT_FOUND');
  });
});

test('POST BET retorna rejeição de negócio e mantém o saldo histórico na repetição', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema, playerId, walletId }) => {
    const rejectedResponse = await submit(
      baseUrl,
      createRequest(playerId, walletId, { money: { amount: '120.00', currency: 'BRL' } }),
      'chave-saldo-insuficiente',
    );
    const rejected = await rejectedResponse.json() as HttpResponseBody;
    expect(rejectedResponse.status).toBe(200);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    const laterResponse = await submit(
      baseUrl,
      createRequest(playerId, walletId, {
        externalTransactionId: 'aposta-http-posterior',
        money: { amount: '5.00', currency: 'BRL' },
      }),
      'chave-http-posterior',
    );
    expect(laterResponse.status).toBe(200);

    const replayResponse = await submit(
      baseUrl,
      createRequest(playerId, walletId, { money: { amount: '120.00', currency: 'BRL' } }),
      'chave-saldo-insuficiente',
    );
    const replay = await replayResponse.json() as HttpResponseBody;
    expect(replayResponse.status).toBe(200);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(rejected.transactionId);
    expect(replay.balance?.amount).toBe('100.00');

    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const rejectedLedgerRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')}
       where "transaction_id" = ?`,
      [rejected.transactionId],
    );
    expect(walletRows).toEqual([{ balance: '95.00', version: 2 }]);
    expect(rejectedLedgerRows).toHaveLength(0);
  });
});

test('POST LOSS registra o resultado sem alterar saldo ou ledger', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema, playerId, walletId }) => {
    const request = createRequest(playerId, walletId, {
      externalTransactionId: 'perda-http-1',
      kind: 'LOSS',
    });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submit(baseUrl, request, 'chave-perda-http-1')),
    );
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<HttpResponseBody>),
    );
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const lossRows = await orm.em.getConnection().execute(
      `select "status", "result_balance"::text as "resultBalance"
       from ${table(schema, 'wager_transactions')} where "kind" = 'LOSS'`,
    );
    const lossLedgerRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')}
       where "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'LOSS'
       )`,
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(bodies.filter((body) => body.idempotentReplay === false)).toHaveLength(1);
    expect(bodies.every((body) => body.status === 'PROCESSED')).toBe(true);
    expect(bodies.every((body) => body.balance?.amount === '100.00')).toBe(true);
    expect(new Set(bodies.map((body) => body.transactionId)).size).toBe(1);

    const kindConflictResponse = await submit(
      baseUrl,
      { ...request, kind: 'BET' },
      'chave-perda-http-1',
    );
    const kindConflict = await kindConflictResponse.json() as HttpResponseBody;
    expect(kindConflictResponse.status).toBe(409);
    expect(kindConflict.code).toBe('IDEMPOTENCY_CONFLICT');

    expect(walletRows).toEqual([{ balance: '100.00', version: 1 }]);
    expect(lossRows).toEqual([{ status: 'PROCESSED', resultBalance: '100.00' }]);
    expect(lossLedgerRows).toHaveLength(0);
  });
});

test('POST wallets grava OPENING e crédito no ledger atomicamente', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema }) => {
    const playerId = randomUUID();
    const response = await createWallet(baseUrl, {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const body = await response.json() as HttpResponseBody;
    expect(response.status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.playerId).toBe(playerId);
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(body.version).toBe(1);

    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", btrim("currency") as "currency", "version"
       from ${table(schema, 'wallets')} where "id" = ?`,
      [body.id],
    );
    const openingOutboxRows = await orm.em.getConnection().execute(
      `select "event_type" as "eventType", "sequence_number" as "sequenceNumber"
       from ${table(schema, 'outbox_messages')}
       where "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')}
         where "wallet_id" = ? and "kind" = 'OPENING'
       )
       order by "sequence_number"`,
      [body.id],
    );
    const openingRows = await orm.em.getConnection().execute(
      `select "status", "result_balance"::text as "resultBalance"
       from ${table(schema, 'wager_transactions')}
       where "wallet_id" = ? and "kind" = 'OPENING'`,
      [body.id],
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select "direction", "amount"::text as "amount",
              "balance_before"::text as "balanceBefore", "balance_after"::text as "balanceAfter"
       from ${table(schema, 'wallet_ledger_entries')} where "wallet_id" = ?`,
      [body.id],
    );

    expect(walletRows).toEqual([{ balance: '100.00', currency: 'BRL', version: 1 }]);
    expect(openingRows).toEqual([{ status: 'PROCESSED', resultBalance: '100.00' }]);
    expect(ledgerRows).toEqual([
      { direction: 'CREDIT', amount: '100.00', balanceBefore: '0.00', balanceAfter: '100.00' },
    ]);
    expect(openingOutboxRows).toEqual([
      { eventType: 'WagerTransactionProcessed', sequenceNumber: 1 },
      { eventType: 'WalletBalanceChanged', sequenceNumber: 2 },
    ]);
  });
});

test('POST wallets aceita saldo zero e resolve criação duplicada no PostgreSQL', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema }) => {
    const zeroBalancePlayerId = randomUUID();
    const zeroResponse = await createWallet(baseUrl, {
      playerId: zeroBalancePlayerId,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const zeroWallet = await zeroResponse.json() as HttpResponseBody;
    expect(zeroResponse.status).toBe(201);
    expect(zeroWallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wager_transactions')}
       where "wallet_id" = ? and "kind" = 'OPENING'`,
      [zeroWallet.id],
    )).toHaveLength(0);
    expect(await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')} where "wallet_id" = ?`,
      [zeroWallet.id],
    )).toHaveLength(0);
    expect(await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'outbox_messages')}
       where "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')}
         where "wallet_id" = ?
       )`,
      [zeroWallet.id],
    )).toHaveLength(0);

    const duplicatePlayerId = randomUUID();
    const duplicateBody = {
      playerId: duplicatePlayerId,
      initialBalance: { amount: '25.00', currency: 'BRL' },
    };
    const duplicateResponses = await Promise.all([
      createWallet(baseUrl, duplicateBody),
      createWallet(baseUrl, duplicateBody),
    ]);
    expect(duplicateResponses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(duplicateResponses.filter((response) => response.status === 409)).toHaveLength(1);
    const duplicateConflict = duplicateResponses.find((response) => response.status === 409);
    expect(duplicateConflict).toBeDefined();
    if (duplicateConflict) {
      const conflictBody = await duplicateConflict.json() as HttpResponseBody;
      expect(conflictBody.code).toBe('WALLET_ALREADY_EXISTS');
    }

    const duplicateWalletRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallets')} where "player_id" = ? and "currency" = 'BRL'`,
      [duplicatePlayerId],
    );
    expect(duplicateWalletRows).toHaveLength(1);

    const differentCurrencyResponse = await createWallet(baseUrl, {
      playerId: duplicatePlayerId,
      initialBalance: { amount: '25.00', currency: 'USD' },
    });
    expect(differentCurrencyResponse.status).toBe(201);
  });
});

test('POST wallets reverte a abertura inteira quando o ledger ou a outbox falha', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema }) => {
    const negativeAmount = await createWallet(baseUrl, {
      playerId: randomUUID(),
      initialBalance: { amount: '-1.00', currency: 'BRL' },
    });
    expect(negativeAmount.status).toBe(400);

    const numericAmount = await createWallet(baseUrl, {
      playerId: randomUUID(),
      initialBalance: { amount: 10, currency: 'BRL' },
    });
    expect(numericAmount.status).toBe(400);

    await orm.em.getConnection().execute(`
      create function ${table(schema, 'falhar_abertura_ledger')}() returns trigger
      language plpgsql as $$
      begin
        raise exception using errcode = 'P0001', message = 'Falha induzida no ledger de abertura';
      end;
      $$;
      create trigger "falha_induzida_no_ledger_de_abertura"
      before insert on ${table(schema, 'wallet_ledger_entries')}
      for each row execute function ${table(schema, 'falhar_abertura_ledger')}();
    `);

    const playerId = randomUUID();
    const failedOpening = await createWallet(baseUrl, {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const failedBody = await failedOpening.json() as HttpResponseBody;
    expect(failedOpening.status).toBe(500);
    expect(failedBody.code).toBe('INTERNAL_ERROR');

    const walletRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallets')} where "player_id" = ?`,
      [playerId],
    );
    const transactionRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wager_transactions')} where "player_id" = ?`,
      [playerId],
    );
    expect(walletRows).toHaveLength(0);
    expect(transactionRows).toHaveLength(0);

    await orm.em.getConnection().execute(`
      drop trigger "falha_induzida_no_ledger_de_abertura"
        on ${table(schema, 'wallet_ledger_entries')};
      drop function ${table(schema, 'falhar_abertura_ledger')}();
      create function ${table(schema, 'falhar_abertura_outbox')}() returns trigger
      language plpgsql as $$
      begin
        raise exception using errcode = 'P0001', message = 'Falha induzida na outbox de abertura';
      end;
      $$;
      create trigger "falha_induzida_na_outbox_de_abertura"
      before insert on ${table(schema, 'outbox_messages')}
      for each row execute function ${table(schema, 'falhar_abertura_outbox')}();
    `);

    const outboxFailurePlayerId = randomUUID();
    const failedOutboxOpening = await createWallet(baseUrl, {
      playerId: outboxFailurePlayerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(failedOutboxOpening.status).toBe(500);
    expect(await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallets')} where "player_id" = ?`,
      [outboxFailurePlayerId],
    )).toHaveLength(0);
    expect(await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wager_transactions')} where "player_id" = ?`,
      [outboxFailurePlayerId],
    )).toHaveLength(0);
    expect(await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')}
       where "wallet_id" in (
         select "id" from ${table(schema, 'wallets')} where "player_id" = ?
       )`,
      [outboxFailurePlayerId],
    )).toHaveLength(0);
    expect(await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'outbox_messages')}
       where "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')} where "player_id" = ?
       )`,
      [outboxFailurePlayerId],
    )).toHaveLength(0);
  });
});
