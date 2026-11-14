/**
 * Esta página oferece comandos explícitos para aplicar ou reverter uma migration.
 * Assinatura: Leonardo de Souza da Luz
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { loadApplicationConfig } from '../../config/application-config.js';
import { createMikroOrmOptions } from './mikro-orm.options.js';

async function runMigrations(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('Informe "up" para aplicar ou "down" para reverter a migration.');
  }

  const config = loadApplicationConfig();
  const orm = await MikroORM.init(
    createMikroOrmOptions(config, config.postgres.schema),
  );
  try {
    if (direction === 'up') {
      await orm.migrator.up();
      process.stdout.write('Migrations pendentes aplicadas.\n');
    } else {
      await orm.migrator.down();
      process.stdout.write('A última migration foi revertida.\n');
    }
  } finally {
    await orm.close(true);
  }
}

void runMigrations().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida ao executar migrations.'}\n`);
  process.exitCode = 1;
});
