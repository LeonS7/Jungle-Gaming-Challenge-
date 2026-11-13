/**
 * Esta página valida BET, WIN e LOSS com concorrência e PostgreSQL reais.
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
    expect(results.every((result) => result.balance.equals(Money.from({ amount: '90.00', currency: 'BRL' })))).toBe(true);
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
    expect(results.every((result) => result.balance.toJSON().amount === '100.00')).toBe(true);
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
    expect(results.every((result) => result.balance.toJSON().amount === '110.00')).toBe(true);
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
    expect(firstResult.balance.toJSON().amount).toBe('90.00');
    expect(replay.balance.toJSON().amount).toBe('90.00');
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
    expect(rejected?.balance.toJSON().amount).toBe('20.00');
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
    expect(rejectedReplay.balance.toJSON().amount).toBe('20.00');
  });
});
