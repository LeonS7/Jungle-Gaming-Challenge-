/**
 * Esta página carrega as configurações e inicia o servidor NestJS.
 * Assinatura: Leonardo de Souza da Luz
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadApplicationConfig } from './config/application-config.js';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const config = loadApplicationConfig();
  const app = await NestFactory.create(
    AppModule.register(config, config.postgres.schema),
  );
  app.enableShutdownHooks();
  await app.listen(config.appPort, '127.0.0.1');
}

void bootstrap();
