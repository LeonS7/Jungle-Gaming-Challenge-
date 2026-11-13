/**
 * Esta página monta o módulo NestJS e conecta o mapeamento MikroORM da aplicação.
 * Assinatura: Leonardo de Souza da Luz
 */
import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWager } from './application/wagering/process-wager.js';
import { OpenWallet } from './application/wallets/open-wallet.js';
import type { ApplicationConfig } from './config/application-config.js';
import { APPLICATION_CONFIG } from './config/config.constants.js';
import { createMikroOrmOptions } from './infrastructure/persistence/mikro-orm.options.js';
import { HealthController } from './presentation/health/health.controller.js';
import { HealthService } from './presentation/health/health.service.js';
import { PostgresWagerPersistence } from './infrastructure/persistence/postgres-wager-persistence.js';
import { PostgresWalletOpeningPersistence } from './infrastructure/persistence/postgres-wallet-opening-persistence.js';
import { WageringController } from './presentation/wagering/wagering.controller.js';
import { WalletsController } from './presentation/wallets/wallets.controller.js';

@Module({})
export class AppModule {
  static register(config: ApplicationConfig, schema?: string): DynamicModule {
    return {
      module: AppModule,
      imports: [
        MikroOrmModule.forRoot(createMikroOrmOptions(config, schema)),
      ],
      controllers: [HealthController, WageringController, WalletsController],
      providers: [
        { provide: APPLICATION_CONFIG, useValue: config },
        HealthService,
        {
          provide: ProcessWager,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) =>
            new ProcessWager(new PostgresWagerPersistence(orm, schema)),
        },
        {
          provide: OpenWallet,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) =>
            new OpenWallet(new PostgresWalletOpeningPersistence(orm, schema)),
        },
      ],
    };
  }
}
