/**
 * Esta página valida operações, reversões e concorrência com PostgreSQL real.
 * Assinatura: Leonardo de Souza da Luz
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { loadApplicationConfig } from '../../../src/config/application-config.js';
import { Money } from '../../../src/domain/money/money.js';
import { createMikroOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.options.js';
import { PostgresWagerPersistence } from '../../../src/infrastructure/persistence/postgres-wager-persistence.js';
import {
  IdempotencyConflictError,
  ProcessWager,
  type ProcessWagerCommand,
} from '../../../src/application/wagering/process-wager.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction.js';

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

async function withPersistence(
  operation: (context: {
    readonly orm: MikroORM;
    readonly schema: string;
    readonly persistence: PostgresWagerPersistence;
    readonly playerId: string;
    readonly walletId: string;
  }) => Promise<void>,
): Promise<void> {
  const config = loadApplicationConfig();
  const schema = `teste_bet_${randomUUID().replaceAll('-', '')}`;
  const playerId = `jogador-${randomUUID()}`;
  const walletId = randomUUID();
  const administrator = await MikroORM.init(createMikroOrmOptions(config));
  let scopedOrm: MikroORM | undefined;

  try {
    await administrator.em.getConnection().execute(`create schema "${schema}"`);
    scopedOrm = await MikroORM.init(createMikroOrmOptions(config, schema));
    await scopedOrm.migrator.up();
    await seedWallet(scopedOrm, schema, walletId, playerId);
    await operation({
      orm: scopedOrm,
      schema,
      persistence: new PostgresWagerPersistence(scopedOrm, schema),
      playerId,
      walletId,
    });
  } finally {
    if (scopedOrm) {
      await scopedOrm.close(true);
    }
    await administrator.em.getConnection().execute(
      `drop schema if exists "${schema}" cascade`,
    );
    await administrator.close(true);
  }
}

function createWager(
  playerId: string,
  walletId: string,
  overrides: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
  return {
    providerId: 'provedor-integracao',
    externalTransactionId: 'aposta-externa-integracao',
    idempotencyKey: 'chave-aposta-integracao',
    payloadHash: 'hash-aposta-integracao',
    playerId,
    walletId,
    roundId: 'rodada-integracao',
    gameId: 'jogo-integracao',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    ...overrides,
  };
}

test('BET concorrentes idênticas geram um único débito e repetição idempotente persistida', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const command = createWager(playerId, walletId);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => processWager.execute(command)),
    );
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const betRows = await orm.em.getConnection().execute(
      `select "status", "result_balance"::text as "resultBalance" from ${table(schema, 'wager_transactions')} where "kind" = 'BET'`,
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select "amount"::text as "amount" from ${table(schema, 'wallet_ledger_entries')} where "wallet_id" = ? and "transaction_id" in (select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'BET')`,
      [walletId],
    );
    const outboxRows = await orm.em.getConnection().execute(
      `select "event_type" as "eventType", "sequence_number" as "sequenceNumber"
       from ${table(schema, 'outbox_messages')}
       where "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'BET'
       )
       order by "sequence_number"`,
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.every((result) => result.balance?.equals(Money.from({ amount: '90.00', currency: 'BRL' })))).toBe(true);
    expect(walletRows[0]).toEqual({ balance: '90.00', version: 2 });
    expect(betRows).toEqual([{ status: 'PROCESSED', resultBalance: '90.00' }]);
    expect(ledgerRows).toEqual([{ amount: '10.00' }]);
    expect(outboxRows).toEqual([
      { eventType: 'WagerTransactionProcessed', sequenceNumber: 1 },
      { eventType: 'WalletBalanceChanged', sequenceNumber: 2 },
    ]);
  });
});

test('LOSS repetida não altera saldo nem cria lançamento no ledger', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const command = createWager(playerId, walletId, {
      kind: WagerTransactionKind.Loss,
      externalTransactionId: 'perda-externa-integracao',
      idempotencyKey: 'chave-perda-integracao',
      payloadHash: 'hash-perda-integracao',
    });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => processWager.execute(command)),
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
    const lossOutboxRows = await orm.em.getConnection().execute(
      `select "event_type" as "eventType", "sequence_number" as "sequenceNumber"
       from ${table(schema, 'outbox_messages')}
       where "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'LOSS'
       )`,
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.every((result) => result.balance?.toJSON().amount === '100.00')).toBe(true);
    expect(walletRows[0]).toEqual({ balance: '100.00', version: 1 });
    expect(lossRows).toEqual([{ status: 'PROCESSED', resultBalance: '100.00' }]);
    expect(lossLedgerRows).toHaveLength(0);
    expect(lossOutboxRows).toEqual([
      { eventType: 'WagerTransactionProcessed', sequenceNumber: 1 },
    ]);
  });
});

test('WIN concorrente gera um crédito e uma entrada imutável no ledger', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const command = createWager(playerId, walletId, {
      externalTransactionId: 'vitoria-externa-integracao',
      idempotencyKey: 'chave-vitoria-integracao',
      payloadHash: 'hash-vitoria-integracao',
      kind: WagerTransactionKind.Win,
    });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => processWager.execute(command)),
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
    const outboxRows = await orm.em.getConnection().execute(
      `select "event_type" as "eventType", "sequence_number" as "sequenceNumber"
       from ${table(schema, 'outbox_messages')}
       where "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'WIN'
       )
       order by "sequence_number"`,
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.every((result) => result.balance?.toJSON().amount === '110.00')).toBe(true);
    expect(walletRows[0]).toEqual({ balance: '110.00', version: 2 });
    expect(winRows).toEqual([{ status: 'PROCESSED', resultBalance: '110.00' }]);
    expect(ledgerRows).toEqual([{
      direction: 'CREDIT',
      amount: '10.00',
      balanceBefore: '100.00',
      balanceAfter: '110.00',
    }]);
    expect(outboxRows).toEqual([
      { eventType: 'WagerTransactionProcessed', sequenceNumber: 1 },
      { eventType: 'WalletBalanceChanged', sequenceNumber: 2 },
    ]);
  });
});

test('outbox registra eventos finais e mudanças de saldo na mesma ordem', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const bet = await processWager.execute(createWager(playerId, walletId));
    const loss = await processWager.execute(createWager(playerId, walletId, {
      externalTransactionId: 'perda-outbox-integracao',
      idempotencyKey: 'chave-perda-outbox-integracao',
      payloadHash: 'hash-perda-outbox-integracao',
      kind: WagerTransactionKind.Loss,
    }));
    const win = await processWager.execute(createWager(playerId, walletId, {
      externalTransactionId: 'vitoria-outbox-integracao',
      idempotencyKey: 'chave-vitoria-outbox-integracao',
      payloadHash: 'hash-vitoria-outbox-integracao',
      kind: WagerTransactionKind.Win,
    }));
    const rejectedBet = await processWager.execute(createWager(playerId, walletId, {
      externalTransactionId: 'aposta-rejeitada-outbox-integracao',
      idempotencyKey: 'chave-aposta-rejeitada-outbox-integracao',
      payloadHash: 'hash-aposta-rejeitada-outbox-integracao',
      money: Money.from({ amount: '200.00', currency: 'BRL' }),
    }));
    const outboxRows = await orm.em.getConnection().execute(
      `select
        "transaction_id" as "transactionId",
        "sequence_number" as "sequenceNumber",
        "event_type" as "eventType",
        "id" as "eventId",
        "payload" ->> 'eventId' as "payloadEventId",
        "payload" ->> 'eventType' as "payloadEventType",
        "payload" #>> '{data,transactionId}' as "payloadTransactionId",
        jsonb_typeof("payload" #> '{data,money,amount}') as "moneyAmountType"
       from ${table(schema, 'outbox_messages')}
       order by "transaction_id", "sequence_number"`,
    );
    const expectedEvents = [
      { transactionId: bet.transactionId, sequenceNumber: 1, eventType: 'WagerTransactionProcessed' },
      { transactionId: bet.transactionId, sequenceNumber: 2, eventType: 'WalletBalanceChanged' },
      { transactionId: loss.transactionId, sequenceNumber: 1, eventType: 'WagerTransactionProcessed' },
      { transactionId: win.transactionId, sequenceNumber: 1, eventType: 'WagerTransactionProcessed' },
      { transactionId: win.transactionId, sequenceNumber: 2, eventType: 'WalletBalanceChanged' },
      { transactionId: rejectedBet.transactionId, sequenceNumber: 1, eventType: 'WagerTransactionRejected' },
    ].sort((left, right) =>
      left.transactionId.localeCompare(right.transactionId) ||
      left.sequenceNumber - right.sequenceNumber,
    );

    expect(rejectedBet.status).toBe(WagerTransactionStatus.Rejected);
    expect(outboxRows.map(({ transactionId, sequenceNumber, eventType }) => ({
      transactionId,
      sequenceNumber,
      eventType,
    }))).toEqual(expectedEvents);
    expect(outboxRows.every((row) =>
      row.eventId === row.payloadEventId &&
      row.eventType === row.payloadEventType &&
      row.transactionId === row.payloadTransactionId &&
      row.moneyAmountType === 'string',
    )).toBe(true);

    const balanceChanges = await orm.em.getConnection().execute(
      `select
        "transaction_id" as "transactionId",
        "payload" #>> '{data,direction}' as "direction",
        "payload" #>> '{data,money,amount}' as "amount",
        "payload" #>> '{data,balanceBefore,amount}' as "balanceBefore",
        "payload" #>> '{data,balanceAfter,amount}' as "balanceAfter"
       from ${table(schema, 'outbox_messages')}
       where "event_type" = 'WalletBalanceChanged'`,
    );
    expect(balanceChanges).toEqual(expect.arrayContaining([
      {
        transactionId: bet.transactionId,
        direction: 'DEBIT',
        amount: '10.00',
        balanceBefore: '100.00',
        balanceAfter: '90.00',
      },
      {
        transactionId: win.transactionId,
        direction: 'CREDIT',
        amount: '10.00',
        balanceBefore: '90.00',
        balanceAfter: '100.00',
      },
    ]));
    await expect(
      orm.em.getConnection().execute(
        `update ${table(schema, 'outbox_messages')} set "payload" = '{}'::jsonb where "id" = ?`,
        [outboxRows[0]?.eventId],
      ),
    ).rejects.toThrow('O conteúdo de uma mensagem da outbox é imutável');
    await expect(
      orm.em.getConnection().execute(
        `delete from ${table(schema, 'outbox_messages')} where "id" = ?`,
        [outboxRows[0]?.eventId],
      ),
    ).rejects.toThrow('Mensagens da outbox não podem ser removidas');
  });
});

test('falha ao gravar a outbox reverte a transação financeira inteira', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    await orm.em.getConnection().execute(`
      create function ${table(schema, 'falhar_insercao_outbox')}() returns trigger
      language plpgsql as $$
      begin
        raise exception using errcode = 'P0001', message = 'Falha induzida na outbox';
      end;
      $$;
      create trigger "falha_induzida_na_outbox"
      before insert on ${table(schema, 'outbox_messages')}
      for each row execute function ${table(schema, 'falhar_insercao_outbox')}();
    `);

    await expect(
      new ProcessWager(persistence).execute(createWager(playerId, walletId)),
    ).rejects.toThrow('Falha induzida na outbox');

    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const transactionRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'BET'`,
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')}
       where "transaction_id" in (
         select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'BET'
       )`,
    );
    const outboxRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'outbox_messages')}`,
    );

    expect(walletRows[0]).toEqual({ balance: '100.00', version: 1 });
    expect(transactionRows).toHaveLength(0);
    expect(ledgerRows).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });
});

test('a repetição idempotente retorna o saldo histórico e rejeita dados diferentes', async () => {
  await withPersistence(async ({ persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const original = createWager(playerId, walletId);
    const firstResult = await processWager.execute(original);
    await processWager.execute(
      createWager(playerId, walletId, {
        externalTransactionId: 'aposta-externa-posterior',
        idempotencyKey: 'chave-aposta-posterior',
        payloadHash: 'hash-aposta-posterior',
        money: Money.from({ amount: '5.00', currency: 'BRL' }),
      }),
    );

    const replay = await processWager.execute(original);
    expect(firstResult.balance?.toJSON().amount).toBe('90.00');
    expect(replay.balance?.toJSON().amount).toBe('90.00');
    expect(replay.transactionId).toBe(firstResult.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    await expect(
      processWager.execute(createWager(playerId, walletId, { payloadHash: 'hash-diferente' })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

test('a chave global resolve a corrida entre carteiras diferentes', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const otherWalletId = randomUUID();
    const otherPlayerId = `jogador-${randomUUID()}`;
    await seedWallet(orm, schema, otherWalletId, otherPlayerId);
    const processWager = new ProcessWager(persistence);
    const outcomes = await Promise.allSettled([
      processWager.execute(
        createWager(playerId, walletId, {
          idempotencyKey: 'chave-global-em-concorrencia',
          externalTransactionId: 'aposta-global-a',
          payloadHash: 'hash-global-a',
        }),
      ),
      processWager.execute(
        createWager(otherPlayerId, otherWalletId, {
          idempotencyKey: 'chave-global-em-concorrencia',
          externalTransactionId: 'aposta-global-b',
          payloadHash: 'hash-global-b',
        }),
      ),
    ]);
    const wagerRows = await orm.em.getConnection().execute(
      `select "wallet_id" as "walletId" from ${table(schema, 'wager_transactions')} where "kind" = 'BET'`,
    );
    const walletRows = await orm.em.getConnection().execute(
      `select "id", "balance"::text as "balance" from ${table(schema, 'wallets')} where "id" in (?, ?) order by "id"`,
      [walletId, otherWalletId],
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejectedOutcome = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejectedOutcome?.status).toBe('rejected');
    if (rejectedOutcome?.status === 'rejected') {
      expect(rejectedOutcome.reason).toBeInstanceOf(IdempotencyConflictError);
    }
    expect(wagerRows).toHaveLength(1);
    expect(walletRows.filter((row) => row.balance === '90.00')).toHaveLength(1);
    expect(walletRows.filter((row) => row.balance === '100.00')).toHaveLength(1);
  });
});

test('falha no ledger reverte os créditos e débitos na mesma operação', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    await orm.em.getConnection().execute(`
      create function ${table(schema, 'falhar_insercao_ledger')}() returns trigger
      language plpgsql as $$
      begin
        raise exception using errcode = 'P0001', message = 'Falha induzida no ledger';
      end;
      $$;
      create trigger "falha_induzida_no_ledger"
      before insert on ${table(schema, 'wallet_ledger_entries')}
      for each row execute function ${table(schema, 'falhar_insercao_ledger')}();
    `);

    await expect(
      new ProcessWager(persistence).execute(createWager(playerId, walletId)),
    ).rejects.toThrow('Falha induzida no ledger');
    await expect(
      new ProcessWager(persistence).execute(createWager(playerId, walletId, {
        externalTransactionId: 'vitoria-ledger-falha',
        idempotencyKey: 'chave-vitoria-ledger-falha',
        payloadHash: 'hash-vitoria-ledger-falha',
        kind: WagerTransactionKind.Win,
      })),
    ).rejects.toThrow('Falha induzida no ledger');

    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const wagerRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wager_transactions')} where "kind" in ('BET', 'WIN')`,
    );
    const wagerLedgerRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')} where "wallet_id" = ? and "transaction_id" in (select "id" from ${table(schema, 'wager_transactions')} where "kind" in ('BET', 'WIN'))`,
      [walletId],
    );

    expect(walletRows[0]).toEqual({ balance: '100.00', version: 1 });
    expect(wagerRows).toHaveLength(0);
    expect(wagerLedgerRows).toHaveLength(0);
  });
});

test('débitos concorrentes não deixam o saldo negativo e armazenam a rejeição', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const firstCommand = createWager(playerId, walletId, {
      externalTransactionId: 'aposta-concorrente-a',
      idempotencyKey: 'chave-concorrente-a',
      payloadHash: 'hash-concorrente-a',
      money: Money.from({ amount: '80.00', currency: 'BRL' }),
    });
    const secondCommand = createWager(playerId, walletId, {
      externalTransactionId: 'aposta-concorrente-b',
      idempotencyKey: 'chave-concorrente-b',
      payloadHash: 'hash-concorrente-b',
      money: Money.from({ amount: '80.00', currency: 'BRL' }),
    });
    const results = await Promise.all([
      processWager.execute(firstCommand),
      processWager.execute(secondCommand),
    ]);
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const betRows = await orm.em.getConnection().execute(
      `select "status", "failure_code" as "failureCode", "result_balance"::text as "resultBalance" from ${table(schema, 'wager_transactions')} where "kind" = 'BET' order by "external_transaction_id"`,
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select "amount"::text as "amount" from ${table(schema, 'wallet_ledger_entries')} where "wallet_id" = ? and "transaction_id" in (select "id" from ${table(schema, 'wager_transactions')} where "kind" = 'BET')`,
      [walletId],
    );
    const rejected = results.find((result) => result.status === WagerTransactionStatus.Rejected);

    expect(results.filter((result) => result.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(rejected?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected?.balance?.toJSON().amount).toBe('20.00');
    expect(walletRows[0]).toEqual({ balance: '20.00', version: 2 });
    expect(betRows.filter((row) => row.status === 'PROCESSED')).toHaveLength(1);
    expect(betRows.filter((row) => row.status === 'REJECTED')).toEqual([
      { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', resultBalance: '20.00' },
    ]);
    expect(ledgerRows).toEqual([{ amount: '80.00' }]);

    const rejectedResultIndex = results.findIndex(
      (result) => result.status === WagerTransactionStatus.Rejected,
    );
    const rejectedCommand = [firstCommand, secondCommand][rejectedResultIndex];
    if (!rejectedCommand) {
      throw new Error('O teste deveria encontrar a BET rejeitada.');
    }
    await processWager.execute(
      createWager(playerId, walletId, {
        externalTransactionId: 'aposta-depois-da-rejeicao',
        idempotencyKey: 'chave-depois-da-rejeicao',
        payloadHash: 'hash-depois-da-rejeicao',
        money: Money.from({ amount: '5.00', currency: 'BRL' }),
      }),
    );
    const rejectedReplay = await processWager.execute(rejectedCommand);
    expect(rejectedReplay.idempotentReplay).toBe(true);
    expect(rejectedReplay.balance?.toJSON().amount).toBe('20.00');
  });
});

test('REFUND e ROLLBACK aplicam a direção inversa e mantêm o ledger auditável', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const bet = createWager(playerId, walletId, {
      externalTransactionId: 'aposta-reversao-valida',
      idempotencyKey: 'chave-aposta-reversao-valida',
      payloadHash: 'hash-aposta-reversao-valida',
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
    });
    const processedBet = await processWager.execute(bet);
    const refund = createWager(playerId, walletId, {
      externalTransactionId: 'reembolso-reversao-valida',
      idempotencyKey: 'chave-reembolso-reversao-valida',
      payloadHash: 'hash-reembolso-reversao-valida',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
      money: bet.money,
    });
    const processedRefund = await processWager.execute(refund);
    const rollbackRefund = createWager(playerId, walletId, {
      externalTransactionId: 'rollback-reembolso-valido',
      idempotencyKey: 'chave-rollback-reembolso-valido',
      payloadHash: 'hash-rollback-reembolso-valido',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: refund.externalTransactionId,
      money: refund.money,
    });
    const processedRefundRollback = await processWager.execute(rollbackRefund);
    const rollbackBet = createWager(playerId, walletId, {
      externalTransactionId: 'rollback-aposta-valido',
      idempotencyKey: 'chave-rollback-aposta-valido',
      payloadHash: 'hash-rollback-aposta-valido',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: bet.externalTransactionId,
      money: bet.money,
    });
    const processedBetRollback = await processWager.execute(rollbackBet);

    expect(processedBet.status).toBe(WagerTransactionStatus.Processed);
    expect(processedBet.balance?.toJSON().amount).toBe('80.00');
    expect(processedRefund.status).toBe(WagerTransactionStatus.Processed);
    expect(processedRefund.balance?.toJSON().amount).toBe('100.00');
    expect(processedRefundRollback.status).toBe(WagerTransactionStatus.Processed);
    expect(processedRefundRollback.balance?.toJSON().amount).toBe('80.00');
    expect(processedBetRollback.status).toBe(WagerTransactionStatus.Processed);
    expect(processedBetRollback.balance?.toJSON().amount).toBe('100.00');

    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version"
       from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const referenceRows = await orm.em.getConnection().execute(
      `select "kind", "reference_transaction_id" as "referenceTransactionId"
       from ${table(schema, 'wager_transactions')}
       where "external_transaction_id" in (?, ?, ?)
       order by "external_transaction_id"`,
      [
        refund.externalTransactionId,
        rollbackRefund.externalTransactionId,
        rollbackBet.externalTransactionId,
      ],
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select wager."kind", ledger."direction",
              ledger."amount"::text as "amount"
       from ${table(schema, 'wallet_ledger_entries')} as ledger
       join ${table(schema, 'wager_transactions')} as wager
         on wager."id" = ledger."transaction_id"
       where wager."external_transaction_id" in (?, ?, ?, ?)
       order by wager."created_at", wager."id"`,
      [
        bet.externalTransactionId,
        refund.externalTransactionId,
        rollbackRefund.externalTransactionId,
        rollbackBet.externalTransactionId,
      ],
    );
    const replay = await processWager.execute(refund);

    expect(walletRows).toEqual([{ balance: '100.00', version: 5 }]);
    expect(referenceRows).toHaveLength(3);
    expect(ledgerRows).toHaveLength(4);
    expect(ledgerRows).toEqual(expect.arrayContaining([
      { kind: 'BET', direction: 'DEBIT', amount: '20.00' },
      { kind: 'REFUND', direction: 'CREDIT', amount: '20.00' },
      { kind: 'ROLLBACK', direction: 'DEBIT', amount: '20.00' },
      { kind: 'ROLLBACK', direction: 'CREDIT', amount: '20.00' },
    ]));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance?.toJSON().amount).toBe('100.00');
  });
});

test('ROLLBACK que deixaria saldo negativo é rejeitado sem lançamento e com código próprio', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const win = createWager(playerId, walletId, {
      externalTransactionId: 'vitoria-a-reverter-sem-saldo',
      idempotencyKey: 'chave-vitoria-a-reverter-sem-saldo',
      payloadHash: 'hash-vitoria-a-reverter-sem-saldo',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '60.00', currency: 'BRL' }),
    });
    await processWager.execute(win);
    await processWager.execute(createWager(playerId, walletId, {
      externalTransactionId: 'aposta-que-consome-premio',
      idempotencyKey: 'chave-aposta-que-consome-premio',
      payloadHash: 'hash-aposta-que-consome-premio',
      money: Money.from({ amount: '150.00', currency: 'BRL' }),
    }));
    const rollback = createWager(playerId, walletId, {
      externalTransactionId: 'rollback-sem-saldo',
      idempotencyKey: 'chave-rollback-sem-saldo',
      payloadHash: 'hash-rollback-sem-saldo',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: win.externalTransactionId,
      money: win.money,
    });

    const result = await processWager.execute(rollback);
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version"
       from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const rollbackRows = await orm.em.getConnection().execute(
      `select "status", "failure_code" as "failureCode",
              "result_balance"::text as "resultBalance"
       from ${table(schema, 'wager_transactions')}
       where "external_transaction_id" = ?`,
      [rollback.externalTransactionId],
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')}
       where "transaction_id" = ?`,
      [result.transactionId],
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(result.balance?.toJSON().amount).toBe('10.00');
    expect(walletRows).toEqual([{ balance: '10.00', version: 3 }]);
    expect(rollbackRows).toEqual([{
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      resultBalance: '10.00',
    }]);
    expect(ledgerRows).toHaveLength(0);
  });
});

test('referência ausente fica pendente, gera evento e reproduz o mesmo status', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const refund = createWager(playerId, walletId, {
      externalTransactionId: 'reembolso-antes-da-aposta',
      idempotencyKey: 'chave-reembolso-antes-da-aposta',
      payloadHash: 'hash-reembolso-antes-da-aposta',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'aposta-ainda-nao-recebida',
      money: Money.from({ amount: '15.00', currency: 'BRL' }),
    });

    const first = await processWager.execute(refund);
    const replay = await processWager.execute(refund);
    const transactionRows = await orm.em.getConnection().execute(
      `select "status", "reference_transaction_id" as "referenceTransactionId",
              "result_balance" as "resultBalance"
       from ${table(schema, 'wager_transactions')} where "id" = ?`,
      [first.transactionId],
    );
    const outboxRows = await orm.em.getConnection().execute(
      `select "event_type" as "eventType", "sequence_number" as "sequenceNumber"
       from ${table(schema, 'outbox_messages')} where "transaction_id" = ?`,
      [first.transactionId],
    );
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version"
       from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );

    expect(first.status).toBe(WagerTransactionStatus.PendingReference);
    expect(first.balance).toBeNull();
    expect(first.idempotentReplay).toBe(false);
    expect(replay.status).toBe(WagerTransactionStatus.PendingReference);
    expect(replay.balance).toBeNull();
    expect(replay.idempotentReplay).toBe(true);
    expect(transactionRows).toEqual([{
      status: 'PENDING_REFERENCE',
      referenceTransactionId: null,
      resultBalance: null,
    }]);
    expect(outboxRows).toEqual([{
      eventType: 'WagerTransactionPendingReference',
      sequenceNumber: 1,
    }]);
    expect(walletRows).toEqual([{ balance: '100.00', version: 1 }]);
  });
});

test('worker resolve uma referência fora de ordem uma única vez entre instâncias concorrentes', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const bet = createWager(playerId, walletId, {
      externalTransactionId: 'aposta-referencia-tardia',
      idempotencyKey: 'chave-aposta-referencia-tardia',
      payloadHash: 'hash-aposta-referencia-tardia',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    const win = createWager(playerId, walletId, {
      externalTransactionId: 'premio-referencia-tardia',
      idempotencyKey: 'chave-premio-referencia-tardia',
      payloadHash: 'hash-premio-referencia-tardia',
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: bet.externalTransactionId,
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
    });

    const pending = await processWager.execute(win);
    await processWager.execute(bet);
    await orm.em.getConnection().execute(
      `update ${table(schema, 'wager_transactions')}
       set "reference_next_attempt_at" = now() - interval '1 second'
       where "id" = ?`,
      [pending.transactionId],
    );

    const processors = Array.from(
      { length: 3 },
      () => new ProcessWager(persistence),
    );
    const results = await Promise.all(
      processors.map((processor) => processor.executeDuePendingReferences()),
    );
    const transactionRows = await orm.em.getConnection().execute(
      `select "status", "reference_transaction_id" as "referenceTransactionId",
              "result_balance"::text as "resultBalance"
       from ${table(schema, 'wager_transactions')} where "id" = ?`,
      [pending.transactionId],
    );
    const events = await orm.em.getConnection().execute(
      `select "event_type" as "eventType", "sequence_number" as "sequenceNumber"
       from ${table(schema, 'outbox_messages')}
       where "transaction_id" = ? order by "sequence_number"`,
      [pending.transactionId],
    );
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version"
       from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const winLedger = await orm.em.getConnection().execute(
      `select "direction", "amount"::text as "amount",
              "balance_before"::text as "balanceBefore",
              "balance_after"::text as "balanceAfter"
       from ${table(schema, 'wallet_ledger_entries')}
       where "transaction_id" = ?`,
      [pending.transactionId],
    );

    expect(results.reduce((count, result) => count + result.claimed, 0)).toBe(1);
    expect(results.reduce((count, result) => count + result.processed, 0)).toBe(1);
    expect(transactionRows).toEqual([{
      status: 'PROCESSED',
      referenceTransactionId: expect.any(String),
      resultBalance: '95.00',
    }]);
    expect(events).toEqual([
      { eventType: 'WagerTransactionPendingReference', sequenceNumber: 1 },
      { eventType: 'WagerTransactionProcessed', sequenceNumber: 2 },
      { eventType: 'WalletBalanceChanged', sequenceNumber: 3 },
    ]);
    expect(walletRows).toEqual([{ balance: '95.00', version: 3 }]);
    expect(winLedger).toEqual([{
      direction: 'CREDIT',
      amount: '5.00',
      balanceBefore: '90.00',
      balanceAfter: '95.00',
    }]);
  });
});

test('worker agenda retry durável e rejeita a referência ao atingir o TTL', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const win = createWager(playerId, walletId, {
      externalTransactionId: 'premio-referencia-expirada',
      idempotencyKey: 'chave-premio-referencia-expirada',
      payloadHash: 'hash-premio-referencia-expirada',
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'aposta-que-nao-chegou',
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
    });
    const pending = await processWager.execute(win);
    await orm.em.getConnection().execute(
      `update ${table(schema, 'wager_transactions')}
       set "reference_next_attempt_at" = now() - interval '1 second'
       where "id" = ?`,
      [pending.transactionId],
    );

    const retryResult = await processWager.executeDuePendingReferences();
    const retryRows = await orm.em.getConnection().execute(
      `select "reference_retry_attempts" as "attempts",
              "reference_next_attempt_at" > now() as "scheduledInFuture"
       from ${table(schema, 'wager_transactions')} where "id" = ?`,
      [pending.transactionId],
    );
    expect(retryResult).toMatchObject({ claimed: 1, retried: 1 });
    expect(retryRows).toEqual([{ attempts: 1, scheduledInFuture: true }]);

    await orm.em.getConnection().execute(
      `update ${table(schema, 'wager_transactions')}
       set "reference_next_attempt_at" = now() - interval '3 seconds',
           "reference_expires_at" = now() - interval '2 seconds'
       where "id" = ?`,
      [pending.transactionId],
    );
    const expiryResult = await processWager.executeDuePendingReferences();
    const transactionRows = await orm.em.getConnection().execute(
      `select "status", "failure_code" as "failureCode",
              "result_balance"::text as "resultBalance",
              "reference_next_attempt_at" as "nextAttemptAt",
              "reference_expires_at" as "expiresAt"
       from ${table(schema, 'wager_transactions')} where "id" = ?`,
      [pending.transactionId],
    );
    const events = await orm.em.getConnection().execute(
      `select "event_type" as "eventType", "sequence_number" as "sequenceNumber"
       from ${table(schema, 'outbox_messages')}
       where "transaction_id" = ? order by "sequence_number"`,
      [pending.transactionId],
    );
    const ledgerRows = await orm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')}
       where "transaction_id" = ?`,
      [pending.transactionId],
    );

    expect(expiryResult).toMatchObject({ claimed: 1, rejected: 1 });
    expect(transactionRows).toEqual([{
      status: 'REJECTED',
      failureCode: 'REFERENCE_EXPIRED',
      resultBalance: '100.00',
      nextAttemptAt: null,
      expiresAt: null,
    }]);
    expect(events).toEqual([
      { eventType: 'WagerTransactionPendingReference', sequenceNumber: 1 },
      { eventType: 'WagerTransactionRejected', sequenceNumber: 2 },
    ]);
    expect(ledgerRows).toHaveLength(0);
  });
});

test('referência de tipo incorreto é rejeitada e duas reversões concorrentes só aplicam uma', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const processWager = new ProcessWager(persistence);
    const loss = createWager(playerId, walletId, {
      externalTransactionId: 'perda-nao-reembolsavel',
      idempotencyKey: 'chave-perda-nao-reembolsavel',
      payloadHash: 'hash-perda-nao-reembolsavel',
      kind: WagerTransactionKind.Loss,
    });
    await processWager.execute(loss);
    const invalidRefund = await processWager.execute(createWager(playerId, walletId, {
      externalTransactionId: 'reembolso-de-perda-invalido',
      idempotencyKey: 'chave-reembolso-de-perda-invalido',
      payloadHash: 'hash-reembolso-de-perda-invalido',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: loss.externalTransactionId,
    }));

    const bet = createWager(playerId, walletId, {
      externalTransactionId: 'aposta-com-reembolso-concorrente',
      idempotencyKey: 'chave-aposta-com-reembolso-concorrente',
      payloadHash: 'hash-aposta-com-reembolso-concorrente',
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
    });
    await processWager.execute(bet);
    const refunds = await Promise.all([
      processWager.execute(createWager(playerId, walletId, {
        externalTransactionId: 'reembolso-concorrente-a',
        idempotencyKey: 'chave-reembolso-concorrente-a',
        payloadHash: 'hash-reembolso-concorrente-a',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
        money: bet.money,
      })),
      processWager.execute(createWager(playerId, walletId, {
        externalTransactionId: 'reembolso-concorrente-b',
        idempotencyKey: 'chave-reembolso-concorrente-b',
        payloadHash: 'hash-reembolso-concorrente-b',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
        money: bet.money,
      })),
    ]);
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version"
       from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const processedRefundLedgers = await orm.em.getConnection().execute(
      `select ledger."id"
       from ${table(schema, 'wallet_ledger_entries')} as ledger
       join ${table(schema, 'wager_transactions')} as wager
         on wager."id" = ledger."transaction_id"
       where wager."reference_external_transaction_id" = ?
         and wager."kind" = 'REFUND'
         and wager."status" = 'PROCESSED'`,
      [bet.externalTransactionId],
    );

    expect(invalidRefund.status).toBe(WagerTransactionStatus.Rejected);
    expect(invalidRefund.failureCode).toBe('INVALID_REFERENCE');
    expect(refunds.filter((result) => result.status === WagerTransactionStatus.Processed))
      .toHaveLength(1);
    expect(refunds.filter((result) => result.failureCode === 'ALREADY_REVERSED'))
      .toHaveLength(1);
    expect(walletRows).toEqual([{ balance: '100.00', version: 3 }]);
    expect(processedRefundLedgers).toHaveLength(1);
  });
});

test('três clientes PostgreSQL independentes não processam duas vezes o mesmo REFUND', async () => {
  await withPersistence(async ({ orm, schema, playerId, walletId }) => {
    const config = loadApplicationConfig();
    const clients = await Promise.all(
      Array.from({ length: 3 }, () =>
        MikroORM.init(createMikroOrmOptions(config, schema)),
      ),
    );
    try {
      const services = clients.map(
        (client) => new ProcessWager(new PostgresWagerPersistence(client, schema)),
      );
      const bet = createWager(playerId, walletId, {
        externalTransactionId: 'aposta-tres-instancias',
        idempotencyKey: 'chave-aposta-tres-instancias',
        payloadHash: 'hash-aposta-tres-instancias',
        money: Money.from({ amount: '60.00', currency: 'BRL' }),
      });
      const firstService = services[0];
      if (!firstService) {
        throw new Error('O teste exige ao menos uma instância do caso de uso.');
      }
      await firstService.execute(bet);
      const results = await Promise.all(
        services.map((service, index) =>
          service.execute(createWager(playerId, walletId, {
            externalTransactionId: `reembolso-tres-instancias-${index}`,
            idempotencyKey: `chave-reembolso-tres-instancias-${index}`,
            payloadHash: `hash-reembolso-tres-instancias-${index}`,
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: bet.externalTransactionId,
            money: bet.money,
          })),
        ),
      );
      const walletRows = await orm.em.getConnection().execute(
        `select "balance"::text as "balance", "version"
         from ${table(schema, 'wallets')} where "id" = ?`,
        [walletId],
      );

      expect(results.filter((result) => result.status === WagerTransactionStatus.Processed))
        .toHaveLength(1);
      expect(results.filter((result) => result.failureCode === 'ALREADY_REVERSED'))
        .toHaveLength(2);
      expect(walletRows).toEqual([{ balance: '100.00', version: 3 }]);
    } finally {
      await Promise.all(clients.map((client) => client.close(true)));
    }
  });
});

test('inbox e wagering fazem commit juntos e redelivery não duplica efeitos', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    const config = loadApplicationConfig();
    const clients = await Promise.all(
      Array.from({ length: 3 }, () =>
        MikroORM.init(createMikroOrmOptions(config, schema)),
      ),
    );
    const processors = clients.map((client) => new ProcessWager(
      new PostgresWagerPersistence(client, schema),
    ));
    const command = createWager(playerId, walletId, {
      externalTransactionId: 'aposta-inbox-atomica',
      idempotencyKey: 'chave-aposta-inbox-atomica',
      payloadHash: 'hash-aposta-inbox-atomica',
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const identity = {
      consumerName: 'wager-processor-v1',
      messageId: 'mensagem-inbox-atomica',
      payloadHash: 'c'.repeat(64),
    };

    try {
      const attempts = await Promise.all(
        processors.map((processor) => processor.executeFromInbox(command, identity)),
      );
      const first = attempts.find((attempt) => !attempt.duplicate);
      if (!first?.result) {
        throw new Error('Uma das mensagens paralelas precisava aplicar a transação.');
      }
      const conflictingReplay = expect(
        processors[0]!.executeFromInbox(command, {
          ...identity,
          payloadHash: 'd'.repeat(64),
        }),
      ).rejects.toThrow('conteúdo diferente');
      const inboxRows = await orm.em.getConnection().execute(
        `select "consumer_name" as "consumerName", "message_id" as "messageId",
                "payload_hash" as "payloadHash", "processed_at" is not null as "processed"
         from ${table(schema, 'inbox_messages')}`,
      );
      const walletRows = await orm.em.getConnection().execute(
        `select "balance"::text as "balance", "version"
         from ${table(schema, 'wallets')} where "id" = ?`,
        [walletId],
      );
      const ledgerRows = await orm.em.getConnection().execute(
        `select "id" from ${table(schema, 'wallet_ledger_entries')}
         where "transaction_id" = ?`,
        [first.result.transactionId],
      );

      await conflictingReplay;
      expect(attempts.filter((attempt) => attempt.duplicate)).toHaveLength(2);
      expect(first.result.status).toBe(WagerTransactionStatus.Processed);
      expect(inboxRows).toHaveLength(1);
      expect(inboxRows[0]).toMatchObject({
        consumerName: identity.consumerName,
        messageId: identity.messageId,
        payloadHash: identity.payloadHash,
      });
      expect(inboxRows[0]?.processed).toBe(true);
      expect(walletRows).toEqual([{ balance: '75.00', version: 2 }]);
      expect(ledgerRows).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((client) => client.close(true)));
    }
  });
});

test('falha depois de inserir inbox reverte inbox, wagering, saldo, ledger e outbox', async () => {
  await withPersistence(async ({ orm, schema, persistence, playerId, walletId }) => {
    await orm.em.getConnection().execute(`
      create function ${table(schema, 'falhar_outbox_inbox')}() returns trigger
      language plpgsql as $$
      begin
        raise exception using errcode = 'P0001', message = 'Falha induzida na outbox da inbox';
      end;
      $$;
      create trigger "falha_outbox_inbox"
      before insert on ${table(schema, 'outbox_messages')}
      for each row execute function ${table(schema, 'falhar_outbox_inbox')}();
    `);
    const processWager = new ProcessWager(persistence);
    const command = createWager(playerId, walletId, {
      externalTransactionId: 'aposta-inbox-rollback',
      idempotencyKey: 'chave-aposta-inbox-rollback',
      payloadHash: 'hash-aposta-inbox-rollback',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    await expect(processWager.executeFromInbox(command, {
      consumerName: 'wager-processor-v1',
      messageId: 'mensagem-inbox-rollback',
      payloadHash: 'e'.repeat(64),
    })).rejects.toThrow('Falha induzida na outbox da inbox');
    const counts = await orm.em.getConnection().execute(
      `select
        (select count(*) from ${table(schema, 'inbox_messages')}) as "inboxCount",
        (select count(*) from ${table(schema, 'wager_transactions')}
          where "external_transaction_id" = ?) as "transactionCount",
        (select count(*) from ${table(schema, 'wallet_ledger_entries')}
          where "wallet_id" = ? and "transaction_id" in (
            select "id" from ${table(schema, 'wager_transactions')}
            where "external_transaction_id" = ?
          )) as "ledgerCount",
        (select count(*) from ${table(schema, 'outbox_messages')}
          where "transaction_id" in (
            select "id" from ${table(schema, 'wager_transactions')}
            where "external_transaction_id" = ?
          )) as "outboxCount"`,
      [
        command.externalTransactionId,
        walletId,
        command.externalTransactionId,
        command.externalTransactionId,
      ],
    );
    const walletRows = await orm.em.getConnection().execute(
      `select "balance"::text as "balance", "version"
       from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );

    expect(counts).toEqual([{
      inboxCount: '0',
      transactionCount: '0',
      ledgerCount: '0',
      outboxCount: '0',
    }]);
    expect(walletRows).toEqual([{ balance: '100.00', version: 1 }]);
  });
});
