/**
 * Esta página verifica consultas e operações HTTP com NestJS e PostgreSQL reais.
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

interface WalletLedgerHttpResponse {
  readonly items?: readonly {
    readonly id: string;
    readonly transactionId: string;
    readonly direction: string;
    readonly money: { readonly amount: string; readonly currency: string };
    readonly balanceBefore: { readonly amount: string; readonly currency: string };
    readonly balanceAfter: { readonly amount: string; readonly currency: string };
    readonly createdAt: string;
  }[];
  readonly nextCursor?: string | null;
  readonly code?: string;
}

interface WagerReadHttpResponse {
  readonly transactionId?: string;
  readonly providerId?: string;
  readonly externalTransactionId?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly money?: { readonly amount: string; readonly currency: string };
  readonly balance?: { readonly amount: string; readonly currency: string } | null;
  readonly code?: string;
}

interface WalletTransactionsHttpResponse {
  readonly items?: readonly {
    readonly transactionId: string;
    readonly externalTransactionId: string;
    readonly walletId: string;
    readonly kind: string;
    readonly money: { readonly amount: string; readonly currency: string };
    readonly status: string;
    readonly failureCode?: string | null;
    readonly balance: { readonly amount: string; readonly currency: string } | null;
    readonly createdAt: string;
    readonly processedAt: string | null;
    readonly idempotencyKey?: string;
    readonly payloadHash?: string;
  }[];
  readonly nextCursor?: string | null;
  readonly code?: string;
}

interface WalletReconciliationHttpResponse {
  readonly walletId?: string;
  readonly storedBalance?: { readonly amount: string; readonly currency: string };
  readonly calculatedBalance?: { readonly amount: string; readonly currency: string };
  readonly difference?: { readonly amount: string; readonly currency: string };
  readonly consistent?: boolean;
  readonly checkedEntries?: number;
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

    application = await NestFactory.create(AppModule.register(config, schema, false), {
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

test('GET / encaminha o navegador para o painel web configurado', async () => {
  await withHttpApplication(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://127.0.0.1:5173');
  });
});

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

test('aceite HTTP cria carteira dedicada e prova concorrência, extrato, ledger e reconciliação', async () => {
  await withHttpApplication(async ({ baseUrl }) => {
    const playerId = `demo-concorrencia-${randomUUID()}`;
    const walletResponse = await createWallet(baseUrl, {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const createdWallet = await walletResponse.json() as HttpResponseBody;
    expect(walletResponse.status).toBe(201);
    expect(createdWallet.id).toBeDefined();
    expect(createdWallet.balance?.amount).toBe('100.00');
    const walletId = createdWallet.id as string;
    const roundId = `rodada-concorrencia-${randomUUID()}`;
    const betA = createRequest(playerId, walletId, {
      externalTransactionId: `bet-a-${randomUUID()}`,
      roundId,
      money: { amount: '80.00', currency: 'BRL' },
    });
    const betB = createRequest(playerId, walletId, {
      externalTransactionId: `bet-b-${randomUUID()}`,
      roundId,
      money: { amount: '80.00', currency: 'BRL' },
    });

    const wagerResponses = await Promise.all([
      submit(baseUrl, betA, `chave-a-${randomUUID()}`),
      submit(baseUrl, betB, `chave-b-${randomUUID()}`),
    ]);
    const wagerBodies = await Promise.all(
      wagerResponses.map((response) => response.json() as Promise<HttpResponseBody>),
    );
    const [walletAfterResponse, transactionsResponse, ledgerResponse, reconciliationResponse] = await Promise.all([
      fetch(`${baseUrl}/wallets/${walletId}`),
      fetch(`${baseUrl}/wallets/${walletId}/transactions?limit=100`),
      fetch(`${baseUrl}/wallets/${walletId}/ledger?limit=100`),
      fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' }),
    ]);
    const walletAfter = await walletAfterResponse.json() as HttpResponseBody;
    const transactions = await transactionsResponse.json() as WalletTransactionsHttpResponse;
    const ledger = await ledgerResponse.json() as WalletLedgerHttpResponse;
    const reconciliation = await reconciliationResponse.json() as WalletReconciliationHttpResponse;
    const betTransactions = transactions.items?.filter((transaction) => transaction.kind === 'BET') ?? [];
    const debits = ledger.items?.filter((entry) => entry.direction === 'DEBIT') ?? [];
    const processedBet = betTransactions.find((transaction) => transaction.status === 'PROCESSED');

    expect(wagerResponses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(wagerBodies.map((body) => body.transactionId)).size).toBe(2);
    expect(wagerBodies.map((body) => body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(wagerBodies.filter((body) => body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    expect(walletAfter.balance?.amount).toBe('20.00');
    expect(betTransactions.map((transaction) => transaction.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(betTransactions.map((transaction) => transaction.money.amount).sort()).toEqual(['80.00', '80.00']);
    expect(betTransactions.filter((transaction) => transaction.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    expect(debits).toHaveLength(1);
    expect(debits[0]?.money.amount).toBe('80.00');
    expect(debits[0]?.transactionId).toBe(processedBet?.transactionId);
    expect(reconciliationResponse.status).toBe(200);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance?.amount).toBe('20.00');
    expect(reconciliation.calculatedBalance?.amount).toBe('20.00');
    expect(reconciliation.checkedEntries).toBe(ledger.items?.length);
  });
});

test('POST WIN credita uma vez e aguarda uma referência ausente', async () => {
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
    expect(referencedWin.status).toBe(202);
    expect(referencedWinBody.status).toBe('PENDING_REFERENCE');
    expect(referencedWinBody.balance).toBeUndefined();
    expect(referencedWinBody.idempotentReplay).toBe(false);

    const repeatedReferencedWin = await submit(
      baseUrl,
      createRequest(playerId, walletId, {
        externalTransactionId: 'vitoria-http-referenciada',
        kind: 'WIN',
        referenceExternalTransactionId: 'aposta-http-1',
      }),
      'chave-vitoria-referenciada',
    );
    const repeatedReferencedWinBody = await repeatedReferencedWin.json() as HttpResponseBody;
    expect(repeatedReferencedWin.status).toBe(202);
    expect(repeatedReferencedWinBody.status).toBe('PENDING_REFERENCE');
    expect(repeatedReferencedWinBody.idempotentReplay).toBe(true);
    const changedReference = await submit(
      baseUrl,
      createRequest(playerId, walletId, {
        externalTransactionId: 'vitoria-http-referenciada',
        kind: 'WIN',
        referenceExternalTransactionId: 'outra-aposta-http',
      }),
      'chave-vitoria-referenciada',
    );
    const changedReferenceBody = await changedReference.json() as HttpResponseBody;
    expect(changedReference.status).toBe(409);
    expect(changedReferenceBody.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await orm.em.getConnection().execute(
      `select "event_type" as "eventType" from ${table(schema, 'outbox_messages')}
       where "transaction_id" = ?`,
      [referencedWinBody.transactionId],
    )).toEqual([{ eventType: 'WagerTransactionPendingReference' }]);
  });
});

test('POST processa REFUND e ROLLBACK com referências e respostas finais', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema, playerId, walletId }) => {
    const betResponse = await submit(
      baseUrl,
      createRequest(playerId, walletId, {
        externalTransactionId: 'aposta-http-para-reembolso',
        kind: 'BET',
      }),
      'chave-aposta-http-para-reembolso',
    );
    const betBody = await betResponse.json() as HttpResponseBody;

    const refundResponse = await submit(
      baseUrl,
      createRequest(playerId, walletId, {
        externalTransactionId: 'reembolso-http',
        kind: 'REFUND',
        referenceExternalTransactionId: 'aposta-http-para-reembolso',
      }),
      'chave-reembolso-http',
    );
    const refundBody = await refundResponse.json() as HttpResponseBody;

    const rollbackResponse = await submit(
      baseUrl,
      createRequest(playerId, walletId, {
        externalTransactionId: 'rollback-http',
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'reembolso-http',
      }),
      'chave-rollback-http',
    );
    const rollbackBody = await rollbackResponse.json() as HttpResponseBody;
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version"
       from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select ledger."direction", ledger."amount"::text as "amount"
       from ${table(schema, 'wallet_ledger_entries')} as ledger
       join ${table(schema, 'wager_transactions')} as wager
         on wager."id" = ledger."transaction_id"
       where wager."external_transaction_id" in (?, ?, ?)
       order by wager."created_at", wager."id"`,
      [
        'aposta-http-para-reembolso',
        'reembolso-http',
        'rollback-http',
      ],
    );

    expect(betResponse.status).toBe(200);
    expect(betBody.status).toBe('PROCESSED');
    expect(refundResponse.status).toBe(200);
    expect(refundBody.status).toBe('PROCESSED');
    expect(refundBody.balance?.amount).toBe('100.00');
    expect(rollbackResponse.status).toBe(200);
    expect(rollbackBody.status).toBe('PROCESSED');
    expect(rollbackBody.balance?.amount).toBe('90.00');
    expect(walletRows).toEqual([{ balance: '90.00', version: 4 }]);
    expect(ledgerRows).toEqual([
      { direction: 'DEBIT', amount: '10.00' },
      { direction: 'CREDIT', amount: '10.00' },
      { direction: 'DEBIT', amount: '10.00' },
    ]);
  });
});

test('POST wagering diferencia entrada inválida e operação interna não suportada', async () => {
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
      createRequest(playerId, walletId, { kind: 'OPENING' }),
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

test('POST LOSS aceita o valor da BET original sem novo movimento financeiro', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema, playerId, walletId }) => {
    const betResponse = await submit(
      baseUrl,
      createRequest(playerId, walletId, {
        externalTransactionId: 'aposta-antes-da-perda',
        money: { amount: '25.00', currency: 'BRL' },
      }),
      'chave-aposta-antes-da-perda',
    );
    const bet = await betResponse.json() as HttpResponseBody;
    expect(betResponse.status).toBe(200);
    expect(bet.status).toBe('PROCESSED');
    expect(bet.balance?.amount).toBe('75.00');

    const lossResponse = await submit(
      baseUrl,
      createRequest(playerId, walletId, {
        externalTransactionId: 'perda-com-valor-da-aposta',
        kind: 'LOSS',
        money: { amount: '25.00', currency: 'BRL' },
      }),
      'chave-perda-com-valor-da-aposta',
    );
    const loss = await lossResponse.json() as HttpResponseBody;
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const lossLedgerRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')} where "transaction_id" = ?`,
      [loss.transactionId],
    );

    expect(lossResponse.status).toBe(200);
    expect(loss.status).toBe('PROCESSED');
    expect(loss.balance?.amount).toBe('75.00');
    expect(walletRows).toEqual([{ balance: '75.00', version: 2 }]);
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

test('GET wallets retorna a carteira e informa quando ela não existe', async () => {
  await withHttpApplication(async ({ baseUrl, walletId }) => {
    const response = await fetch(`${baseUrl}/wallets/${walletId}`);
    const body = await response.json() as HttpResponseBody;

    expect(response.status).toBe(200);
    expect(body.id).toBe(walletId);
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(body.version).toBe(1);

    const defaultLedgerResponse = await fetch(`${baseUrl}/wallets/${walletId}/ledger`);
    const defaultLedger = await defaultLedgerResponse.json() as WalletLedgerHttpResponse;
    expect(defaultLedgerResponse.status).toBe(200);
    expect(defaultLedger.items).toHaveLength(1);
    expect(defaultLedger.nextCursor).toBeNull();

    const missing = await fetch(`${baseUrl}/wallets/${randomUUID()}`);
    const missingBody = await missing.json() as HttpResponseBody;
    expect(missing.status).toBe(404);
    expect(missingBody.code).toBe('WALLET_NOT_FOUND');

    const invalid = await fetch(`${baseUrl}/wallets/nao-e-uuid`);
    const invalidBody = await invalid.json() as HttpResponseBody;
    expect(invalid.status).toBe(400);
    expect(invalidBody.code).toBe('INVALID_REQUEST');
  });
});

test('POST reconciliação informa divergência e incrementa a métrica operacional', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema, walletId }) => {
    const consistentResponse = await fetch(
      `${baseUrl}/wallets/${walletId}/reconciliation`,
      { method: 'POST' },
    );
    const consistentResult = await consistentResponse.json() as WalletReconciliationHttpResponse;
    expect(consistentResponse.status).toBe(200);
    expect(consistentResult).toEqual({
      walletId,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });

    await orm.em.getConnection().execute(
      `update ${table(schema, 'wallets')}
       set "balance" = "balance" + 1.00, "version" = "version" + 1
       where "id" = ?`,
      [walletId],
    );

    const reconciliationResponse = await fetch(
      `${baseUrl}/wallets/${walletId}/reconciliation`,
      { method: 'POST' },
    );
    const result = await reconciliationResponse.json() as WalletReconciliationHttpResponse;
    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    const metrics = await metricsResponse.text();

    expect(reconciliationResponse.status).toBe(200);
    expect(result).toEqual({
      walletId,
      storedBalance: { amount: '101.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '1.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
    });
    expect(metrics).toContain('wallet_reconciliation_divergences_total 1');
  });
});

test('GET wallet ledger pagina por cursor opaco sem repetir lançamentos', async () => {
  await withHttpApplication(async ({ baseUrl, playerId, walletId }) => {
    for (const [index, amount] of ['3.00', '4.00', '5.00'].entries()) {
      const response = await submit(
        baseUrl,
        createRequest(playerId, walletId, {
          externalTransactionId: `lancamento-pagina-${index}`,
          money: { amount, currency: 'BRL' },
        }),
        `chave-lancamento-pagina-${index}`,
      );
      expect(response.status).toBe(200);
    }

    const firstPageResponse = await fetch(
      `${baseUrl}/wallets/${walletId}/ledger?limit=2`,
    );
    const firstPage = await firstPageResponse.json() as WalletLedgerHttpResponse;
    expect(firstPageResponse.status).toBe(200);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(firstPage.items?.[0]?.createdAt).toBeDefined();
    expect(firstPage.items?.[0]?.money.amount).toMatch(/^\d+\.\d{2}$/);
    expect(Date.parse(firstPage.items?.[0]?.createdAt ?? ''))
      .toBeGreaterThanOrEqual(Date.parse(firstPage.items?.[1]?.createdAt ?? ''));

    const otherWalletResponse = await createWallet(baseUrl, {
      playerId: `jogador-${randomUUID()}`,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const otherWallet = await otherWalletResponse.json() as HttpResponseBody;
    const cursorFromOtherWallet = await fetch(
      `${baseUrl}/wallets/${otherWallet.id}/ledger?cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    );
    expect(cursorFromOtherWallet.status).toBe(400);

    const cursor = encodeURIComponent(firstPage.nextCursor ?? '');
    const secondPageResponse = await fetch(
      `${baseUrl}/wallets/${walletId}/ledger?limit=2&cursor=${cursor}`,
    );
    const secondPage = await secondPageResponse.json() as WalletLedgerHttpResponse;
    expect(secondPageResponse.status).toBe(200);
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();

    const allEntryIds = [
      ...(firstPage.items ?? []).map((entry) => entry.id),
      ...(secondPage.items ?? []).map((entry) => entry.id),
    ];
    expect(new Set(allEntryIds).size).toBe(4);

    const invalidLimit = await fetch(
      `${baseUrl}/wallets/${walletId}/ledger?limit=101`,
    );
    const invalidLimitBody = await invalidLimit.json() as HttpResponseBody;
    expect(invalidLimit.status).toBe(400);
    expect(invalidLimitBody.code).toBe('INVALID_REQUEST');

    const invalidCursor = await fetch(
      `${baseUrl}/wallets/${walletId}/ledger?cursor=cursor-invalido`,
    );
    const invalidCursorBody = await invalidCursor.json() as HttpResponseBody;
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursorBody.code).toBe('INVALID_REQUEST');

    const missingWalletLedger = await fetch(
      `${baseUrl}/wallets/${randomUUID()}/ledger`,
    );
    expect(missingWalletLedger.status).toBe(404);
  });
});

test('GET wallet transactions recupera histórico persistido por páginas estáveis', async () => {
  await withHttpApplication(async ({ baseUrl, orm, schema, playerId, walletId }) => {
    const createdTransactionIds: string[] = [];
    for (const [index, amount] of ['3.00', '4.00', '5.00'].entries()) {
      const response = await submit(
        baseUrl,
        createRequest(playerId, walletId, {
          externalTransactionId: `historico-pagina-${index}`,
          money: { amount, currency: 'BRL' },
        }),
        `chave-historico-pagina-${index}`,
      );
      const body = await response.json() as HttpResponseBody;
      expect(response.status).toBe(200);
      expect(body.transactionId).toBeDefined();
      createdTransactionIds.push(body.transactionId ?? '');
    }

    const walletBefore = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const ledgerBefore = await orm.em.getConnection().execute(
      `select count(*)::text as "count" from ${table(schema, 'wallet_ledger_entries')} where "wallet_id" = ?`,
      [walletId],
    );
    const transactionsBefore = await orm.em.getConnection().execute(
      `select count(*)::text as "count" from ${table(schema, 'wager_transactions')} where "wallet_id" = ?`,
      [walletId],
    );
    const outboxBefore = await orm.em.getConnection().execute(
      `select count(*)::text as "count" from ${table(schema, 'outbox_messages')}`,
    );

    const firstResponse = await fetch(
      `${baseUrl}/wallets/${walletId}/transactions?limit=2`,
    );
    const firstPage = await firstResponse.json() as WalletTransactionsHttpResponse;
    expect(firstResponse.status).toBe(200);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(firstPage.items?.[0]?.money.amount).toMatch(/^\d+\.\d{2}$/);
    expect(firstPage.items?.[0]?.transactionId).not.toBe(
      firstPage.items?.[1]?.transactionId,
    );
    expect(firstPage.items?.[0]?.idempotencyKey).toBeUndefined();
    expect(firstPage.items?.[0]?.payloadHash).toBeUndefined();

    const secondResponse = await fetch(
      `${baseUrl}/wallets/${walletId}/transactions?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    );
    const secondPage = await secondResponse.json() as WalletTransactionsHttpResponse;
    expect(secondResponse.status).toBe(200);
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();

    const listedIds = [
      ...(firstPage.items ?? []).map((transaction) => transaction.transactionId),
      ...(secondPage.items ?? []).map((transaction) => transaction.transactionId),
    ];
    expect(new Set(listedIds).size).toBe(4);
    expect(createdTransactionIds.every((id) => listedIds.includes(id))).toBe(true);
    const openingRows = await orm.em.getConnection().execute(
      `select "id" as "id" from ${table(schema, 'wager_transactions')} where "kind" = 'OPENING'`,
    ) as { id: string }[];
    expect(openingRows).toHaveLength(1);
    const openingTransactionId = openingRows[0]?.id;
    if (openingTransactionId === undefined) {
      throw new Error('A fixture de teste deve conter a transação OPENING.');
    }
    expect(listedIds).toContain(openingTransactionId);

    const otherWalletResponse = await createWallet(baseUrl, {
      playerId: `jogador-${randomUUID()}`,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    const otherWallet = await otherWalletResponse.json() as HttpResponseBody;
    const wrongWalletCursorResponse = await fetch(
      `${baseUrl}/wallets/${otherWallet.id}/transactions?cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    );
    expect(wrongWalletCursorResponse.status).toBe(400);

    const invalidCursorResponse = await fetch(
      `${baseUrl}/wallets/${walletId}/transactions?cursor=cursor-invalido`,
    );
    expect(invalidCursorResponse.status).toBe(400);
    const invalidLimitResponse = await fetch(
      `${baseUrl}/wallets/${walletId}/transactions?limit=101`,
    );
    expect(invalidLimitResponse.status).toBe(400);
    const missingWalletResponse = await fetch(
      `${baseUrl}/wallets/${randomUUID()}/transactions`,
    );
    expect(missingWalletResponse.status).toBe(404);

    expect(await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    )).toEqual(walletBefore);
    expect(await orm.em.getConnection().execute(
      `select count(*)::text as "count" from ${table(schema, 'wallet_ledger_entries')} where "wallet_id" = ?`,
      [walletId],
    )).toEqual(ledgerBefore);
    expect(await orm.em.getConnection().execute(
      `select count(*)::text as "count" from ${table(schema, 'wager_transactions')} where "wallet_id" = ?`,
      [walletId],
    )).toEqual(transactionsBefore);
    expect(await orm.em.getConnection().execute(
      `select count(*)::text as "count" from ${table(schema, 'outbox_messages')}`,
    )).toEqual(outboxBefore);
  });
});

test('GET transaction consulta pelo ID interno e pela identidade do provedor', async () => {
  await withHttpApplication(async ({ baseUrl, playerId, walletId }) => {
    const request = createRequest(playerId, walletId, {
      externalTransactionId: 'aposta-consulta-http',
    });
    const created = await submit(baseUrl, request, 'chave-consulta-http');
    const createdBody = await created.json() as HttpResponseBody;
    expect(created.status).toBe(200);

    const byIdResponse = await fetch(
      `${baseUrl}/wagering/transactions/${createdBody.transactionId}`,
    );
    const byId = await byIdResponse.json() as WagerReadHttpResponse;
    expect(byIdResponse.status).toBe(200);
    expect(byId.transactionId).toBe(createdBody.transactionId);
    expect(byId.providerId).toBe('provedor-http');
    expect(byId.externalTransactionId).toBe('aposta-consulta-http');
    expect(byId.kind).toBe('BET');
    expect(byId.status).toBe('PROCESSED');
    expect(byId.money).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(byId.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    const byProviderResponse = await fetch(
      `${baseUrl}/providers/provedor-http/wagering/transactions/aposta-consulta-http`,
    );
    const byProvider = await byProviderResponse.json() as WagerReadHttpResponse;
    expect(byProviderResponse.status).toBe(200);
    expect(byProvider.transactionId).toBe(createdBody.transactionId);
    expect(byProvider.externalTransactionId).toBe('aposta-consulta-http');

    const wrongProvider = await fetch(
      `${baseUrl}/providers/outro-provedor/wagering/transactions/aposta-consulta-http`,
    );
    const wrongProviderBody = await wrongProvider.json() as WagerReadHttpResponse;
    expect(wrongProvider.status).toBe(404);
    expect(wrongProviderBody.code).toBe('TRANSACTION_NOT_FOUND');

    const missing = await fetch(`${baseUrl}/wagering/transactions/${randomUUID()}`);
    expect(missing.status).toBe(404);

    const invalidId = await fetch(`${baseUrl}/wagering/transactions/id-invalido`);
    expect(invalidId.status).toBe(400);
  });
});
