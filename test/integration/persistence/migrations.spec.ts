/**
 * Esta página verifica migrations e constraints contra um PostgreSQL real.
 * Assinatura: Leonardo de Souza da Luz
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadApplicationConfig } from '../../../src/config/application-config.js';
import { createMikroOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.options.js';

interface WalletSeed {
  readonly id: string;
  readonly playerId: string;
  readonly currency?: string;
  readonly balance?: string;
  readonly version?: number;
}

interface WagerSeed {
  readonly id: string;
  readonly providerId?: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind?: string;
  readonly amount?: string;
  readonly referenceExternalTransactionId?: string | null;
  readonly referenceTransactionId?: string | null;
}

function table(schema: string, name: string): string {
  return `"${schema}"."${name}"`;
}

async function insertWallet(
  orm: MikroORM,
  schema: string,
  seed: WalletSeed,
): Promise<void> {
  await orm.em.getConnection().execute(
    `insert into ${table(schema, 'wallets')} (
      "id", "player_id", "currency", "balance", "version"
    ) values (?, ?, ?, ?, ?)` ,
    [
      seed.id,
      seed.playerId,
      seed.currency ?? 'BRL',
      seed.balance ?? '100.00',
      seed.version ?? 1,
    ],
  );
}

async function insertWager(
  orm: MikroORM,
  schema: string,
  seed: WagerSeed,
): Promise<void> {
  await orm.em.getConnection().execute(
    `insert into ${table(schema, 'wager_transactions')} (
      "id", "provider_id", "external_transaction_id", "idempotency_key", "payload_hash",
      "wallet_id", "player_id", "currency", "round_id", "game_id", "kind", "amount",
      "reference_external_transaction_id", "reference_transaction_id", "status",
      "failure_code", "processed_at"
    ) values (?, ?, ?, ?, 'sha256-hash', ?, ?, 'BRL', 'round-a', 'game-a', ?, ?, ?, ?, 'PENDING', null, null)` ,
    [
      seed.id,
      seed.providerId ?? 'provider-a',
      seed.externalTransactionId,
      seed.idempotencyKey,
      seed.walletId,
      seed.playerId,
      seed.kind ?? 'BET',
      seed.amount ?? '10.00',
      seed.referenceExternalTransactionId ?? null,
      seed.referenceTransactionId ?? null,
    ],
  );
}

test('migration PostgreSQL aplica, protege invariantes e reverte o schema', async () => {
  const config = loadApplicationConfig();
  const schema = `teste_${randomUUID().replaceAll('-', '')}`;
  const administrator = await MikroORM.init(createMikroOrmOptions(config));
  let scopedOrm: MikroORM | undefined;

  try {
    await administrator.em.getConnection().execute(`create schema "${schema}"`);
    scopedOrm = await MikroORM.init(createMikroOrmOptions(config, schema));
    await scopedOrm.migrator.up();

    const tableRows = await scopedOrm.em.getConnection().execute(
      'select table_name from information_schema.tables where table_schema = ? order by table_name',
      [schema],
    );
    expect(tableRows).toEqual(
      expect.arrayContaining([
        { table_name: 'wallets' },
        { table_name: 'wager_transactions' },
        { table_name: 'wallet_ledger_entries' },
        { table_name: 'outbox_messages' },
      ]),
    );

    const walletId = randomUUID();
    const playerId = 'jogador-integracao';
    await insertWallet(scopedOrm, schema, { id: walletId, playerId });

    await expect(
      insertWallet(scopedOrm, schema, {
        id: randomUUID(),
        playerId,
      }),
    ).rejects.toThrow();
    await expect(
      insertWallet(scopedOrm, schema, {
        id: randomUUID(),
        playerId: 'jogador-saldo-negativo',
        balance: '-0.01',
      }),
    ).rejects.toThrow();
    await expect(
      insertWallet(scopedOrm, schema, {
        id: randomUUID(),
        playerId: 'jogador-versao-invalida',
        version: 2,
      }),
    ).rejects.toThrow();

    const betId = randomUUID();
    await insertWager(scopedOrm, schema, {
      id: betId,
      externalTransactionId: 'aposta-externa-1',
      idempotencyKey: 'chave-aposta-1',
      walletId,
      playerId,
    });
    await expect(
      insertWager(scopedOrm, schema, {
        id: randomUUID(),
        providerId: 'provider-b',
        externalTransactionId: 'aposta-externa-provider-b',
        idempotencyKey: 'chave-aposta-1',
        walletId,
        playerId,
      }),
    ).rejects.toThrow();

    const pendingId = randomUUID();
    await insertWager(scopedOrm, schema, {
      id: pendingId,
      externalTransactionId: 'aposta-pendente',
      idempotencyKey: 'chave-aposta-pendente',
      walletId,
      playerId,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'aposta-ainda-nao-recebida',
    });
    await scopedOrm.em.getConnection().execute(
      `update ${table(schema, 'wager_transactions')} set "status" = 'PENDING_REFERENCE' where "id" = ?`,
      [pendingId],
    );
    await scopedOrm.em.getConnection().execute(
      `update ${table(schema, 'wager_transactions')}
       set "status" = 'REJECTED', "failure_code" = 'REFERENCE_NOT_FOUND',
           "result_balance" = '100.00', "result_currency" = 'BRL' where "id" = ?`,
      [pendingId],
    );
    await expect(
      scopedOrm.em.getConnection().execute(
        `update ${table(schema, 'wager_transactions')}
         set "status" = 'REJECTED', "failure_code" = 'DUPLICATE' where "id" = ?`,
        [pendingId],
      ),
    ).rejects.toThrow('Uma transação terminal');

    const partialSnapshotId = randomUUID();
    await insertWager(scopedOrm, schema, {
      id: partialSnapshotId,
      externalTransactionId: 'aposta-snapshot-incompleto',
      idempotencyKey: 'chave-snapshot-incompleto',
      walletId,
      playerId,
    });
    await expect(
      scopedOrm.em.getConnection().execute(
        `update ${table(schema, 'wager_transactions')}
         set "status" = 'REJECTED', "failure_code" = 'TEST_ERROR',
             "result_balance" = '100.00', "result_currency" = null
         where "id" = ?`,
        [partialSnapshotId],
      ),
    ).rejects.toThrow();

    const ledgerId = randomUUID();
    await scopedOrm.em.getConnection().execute(
      `insert into ${table(schema, 'wallet_ledger_entries')} (
        "id", "wallet_id", "transaction_id", "direction", "amount", "currency",
        "balance_before", "balance_after"
      ) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '90.00')`,
      [ledgerId, walletId, betId],
    );
    await expect(
      scopedOrm.em.getConnection().execute(
        `update ${table(schema, 'wallet_ledger_entries')} set "amount" = 9.00 where "id" = ?`,
        [ledgerId],
      ),
    ).rejects.toThrow('Lançamentos do ledger são imutáveis');
    await expect(
      scopedOrm.em.getConnection().execute(
        `delete from ${table(schema, 'wallet_ledger_entries')} where "id" = ?`,
        [ledgerId],
      ),
    ).rejects.toThrow('Lançamentos do ledger são imutáveis');
    await expect(
      scopedOrm.em.getConnection().execute(
        `truncate table ${table(schema, 'wallet_ledger_entries')}`,
      ),
    ).rejects.toThrow('Lançamentos do ledger são imutáveis');

    await expect(
      scopedOrm.em.getConnection().execute(
        `update ${table(schema, 'wallets')} set "balance" = 90.00 where "id" = ?`,
        [walletId],
      ),
    ).rejects.toThrow('A versão deve avançar uma unidade');
    await scopedOrm.em.getConnection().execute(
      `update ${table(schema, 'wallets')} set "balance" = 90.00, "version" = 2 where "id" = ?`,
      [walletId],
    );
    await scopedOrm.em.getConnection().execute(
      `update ${table(schema, 'wager_transactions')}
       set "status" = 'PROCESSED', "processed_at" = now(),
           "result_balance" = '90.00', "result_currency" = 'BRL'
       where "id" = ?`,
      [betId],
    );

    const refundSeed = {
      id: randomUUID(),
      externalTransactionId: 'reembolso-externo-1',
      idempotencyKey: 'chave-reembolso-1',
      walletId,
      playerId,
      kind: 'REFUND',
      referenceExternalTransactionId: 'aposta-externa-1',
      referenceTransactionId: betId,
    } as const;
    await insertWager(scopedOrm, schema, refundSeed);
    const firstRefundLedgerId = randomUUID();
    await scopedOrm.em.getConnection().execute(
      `insert into ${table(schema, 'wallet_ledger_entries')} (
        "id", "wallet_id", "transaction_id", "direction", "amount", "currency",
        "balance_before", "balance_after"
      ) values (?, ?, ?, 'CREDIT', '10.00', 'BRL', '90.00', '100.00')`,
      [firstRefundLedgerId, walletId, refundSeed.id],
    );
    await scopedOrm.em.getConnection().execute(
      `update ${table(schema, 'wallets')} set "balance" = 100.00, "version" = 3 where "id" = ?`,
      [walletId],
    );
    await scopedOrm.em.getConnection().execute(
      `update ${table(schema, 'wager_transactions')}
       set "status" = 'PROCESSED', "processed_at" = now(),
           "result_balance" = '100.00', "result_currency" = 'BRL'
       where "id" = ?`,
      [refundSeed.id],
    );

    const secondRefund = {
      ...refundSeed,
      id: randomUUID(),
      externalTransactionId: 'reembolso-externo-2',
      idempotencyKey: 'chave-reembolso-2',
    } as const;
    await insertWager(scopedOrm, schema, secondRefund);
    await expect(
      scopedOrm.em.transactional(async (entityManager) => {
        const transactionContext = entityManager.getTransactionContext();
        await entityManager.getConnection().execute(
          `insert into ${table(schema, 'wallet_ledger_entries')} (
            "id", "wallet_id", "transaction_id", "direction", "amount", "currency",
            "balance_before", "balance_after"
          ) values (?, ?, ?, 'CREDIT', '10.00', 'BRL', '100.00', '110.00')`,
          [randomUUID(), walletId, secondRefund.id],
          'all',
          transactionContext,
        );
        await entityManager.getConnection().execute(
          `update ${table(schema, 'wallets')} set "balance" = 110.00, "version" = 4 where "id" = ?`,
          [walletId],
          'all',
          transactionContext,
        );
        await entityManager.getConnection().execute(
          `update ${table(schema, 'wager_transactions')}
           set "status" = 'PROCESSED', "processed_at" = now(),
               "result_balance" = '110.00', "result_currency" = 'BRL'
           where "id" = ?`,
          [secondRefund.id],
          'all',
          transactionContext,
        );
      }),
    ).rejects.toThrow();
    const rolledBackWallet = await scopedOrm.em.getConnection().execute(
      `select "balance"::text as "balance" from ${table(schema, 'wallets')} where "id" = ?`,
      [walletId],
    );
    const rolledBackLedger = await scopedOrm.em.getConnection().execute(
      `select "id" from ${table(schema, 'wallet_ledger_entries')} where "transaction_id" = ?`,
      [secondRefund.id],
    );
    expect(rolledBackWallet[0]).toEqual({ balance: '100.00' });
    expect(rolledBackLedger).toHaveLength(0);

    await scopedOrm.migrator.down();
    const remainingRows = await scopedOrm.em.getConnection().execute(
      'select table_name from information_schema.tables where table_schema = ? and table_name in (?, ?, ?, ?)',
      [schema, 'wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages'],
    );
    expect(remainingRows).toHaveLength(3);
    const removedOutbox = await scopedOrm.em.getConnection().execute(
      'select table_name from information_schema.tables where table_schema = ? and table_name = ?',
      [schema, 'outbox_messages'],
    );
    expect(removedOutbox).toHaveLength(0);
    const removedSnapshot = await scopedOrm.em.getConnection().execute(
      'select column_name from information_schema.columns where table_schema = ? and table_name = ? and column_name = ?',
      [schema, 'wager_transactions', 'result_balance'],
    );
    expect(removedSnapshot).toHaveLength(1);

    await scopedOrm.migrator.down();
    const retainedSnapshot = await scopedOrm.em.getConnection().execute(
      'select column_name from information_schema.columns where table_schema = ? and table_name = ? and column_name = ?',
      [schema, 'wager_transactions', 'result_balance'],
    );
    expect(retainedSnapshot).toHaveLength(1);

    await scopedOrm.migrator.down();
    const removedEarlierSnapshot = await scopedOrm.em.getConnection().execute(
      'select column_name from information_schema.columns where table_schema = ? and table_name = ? and column_name = ?',
      [schema, 'wager_transactions', 'result_balance'],
    );
    expect(removedEarlierSnapshot).toHaveLength(0);

    await scopedOrm.migrator.down();
    const removedBaseTables = await scopedOrm.em.getConnection().execute(
      'select table_name from information_schema.tables where table_schema = ? and table_name in (?, ?, ?)',
      [schema, 'wallets', 'wager_transactions', 'wallet_ledger_entries'],
    );
    expect(removedBaseTables).toHaveLength(0);

    await scopedOrm.migrator.up();
    const restoredRows = await scopedOrm.em.getConnection().execute(
      'select table_name from information_schema.tables where table_schema = ? and table_name = ?',
      [schema, 'wallets'],
    );
    expect(restoredRows).toHaveLength(1);
  } finally {
    if (scopedOrm) {
      await scopedOrm.close(true);
    }
    await administrator.em.getConnection().execute(`drop schema if exists "${schema}" cascade`);
    await administrator.close(true);
  }
});
