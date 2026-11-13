/**
 * Esta página centraliza o mapeamento MikroORM usado pela aplicação e migrations.
 * Assinatura: Leonardo de Souza da Luz
 */
import 'reflect-metadata';
import { Migrator } from '@mikro-orm/migrations';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import type { Options as PostgreSqlOptions } from '@mikro-orm/postgresql';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { ApplicationConfig } from '../../config/application-config.js';
import { Migration20261113000000_CreateWageringSchema } from './migrations/Migration20261113000000_CreateWageringSchema.js';
import { Migration20261113010000_AddWagerResultSnapshot } from './migrations/Migration20261113010000_AddWagerResultSnapshot.js';
import { Migration20261113020000_StrengthenWagerResultSnapshot } from './migrations/Migration20261113020000_StrengthenWagerResultSnapshot.js';
import { Migration20261113030000_AddTransactionalOutbox } from './migrations/Migration20261113030000_AddTransactionalOutbox.js';
import { WalletLedgerEntryRecord } from './entities/wallet-ledger-entry-record.entity.js';
import { WalletRecord } from './entities/wallet-record.entity.js';
import { WagerTransactionRecord } from './entities/wager-transaction-record.entity.js';

export function createMikroOrmOptions(
  config: ApplicationConfig,
  schema?: string,
): PostgreSqlOptions {
  return {
    driver: PostgreSqlDriver,
    host: config.postgres.host,
    port: config.postgres.port,
    dbName: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    entities: [WalletRecord, WagerTransactionRecord, WalletLedgerEntryRecord],
    metadataProvider: ReflectMetadataProvider,
    extensions: [Migrator],
    debug: false,
    ...(schema ? { schema } : {}),
    migrations: {
      migrationsList: [
        Migration20261113000000_CreateWageringSchema,
        Migration20261113010000_AddWagerResultSnapshot,
        Migration20261113020000_StrengthenWagerResultSnapshot,
        Migration20261113030000_AddTransactionalOutbox,
      ],
      transactional: true,
      allOrNothing: true,
      ...(schema ? { schema } : {}),
    },
  };
}
