/**
 * Esta página testa a validação das configurações da aplicação.
 * Assinatura: Leonardo de Souza da Luz
 */
import { describe, expect, test } from 'bun:test';
import { loadApplicationConfig } from '../../src/config/application-config.js';

const validEnvironment = {
  APP_PORT: '3000',
  DATABASE_HOST: '127.0.0.1',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'jungle_wagering',
  DATABASE_USER: 'jungle',
  DATABASE_PASSWORD: 'local-only',
  AWS_REGION: 'us-east-1',
  AWS_ENDPOINT: 'http://localhost:4566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_QUEUE_NAME: 'wager-transactions.fifo',
  SQS_DLQ_QUEUE_NAME: 'wager-transactions-dlq.fifo',
  SQS_OUTBOX_QUEUE_NAME: 'wager-events.fifo',
};

describe('carregamento da configuração da aplicação', () => {
  test('interpreta uma configuração local válida', () => {
    const config = loadApplicationConfig(validEnvironment);

    expect(config.appPort).toBe(3000);
    expect(config.webPanelUrl).toBe('http://127.0.0.1:5173');
    expect(config.postgres.port).toBe(5432);
    expect(config.sqs.endpoint).toBe('http://localhost:4566');
    expect(config.sqs.outboxQueueName).toBe('wager-events.fifo');
  });

  test('rejeita um valor obrigatório ausente', () => {
    const environment = { ...validEnvironment, DATABASE_PASSWORD: '' };

    expect(() => loadApplicationConfig(environment)).toThrow(
      'A variável de ambiente obrigatória DATABASE_PASSWORD não foi informada.',
    );
  });

  test('rejeita a ausência da fila de saída da outbox', () => {
    const environment = { ...validEnvironment, SQS_OUTBOX_QUEUE_NAME: '' };

    expect(() => loadApplicationConfig(environment)).toThrow(
      'A variável de ambiente obrigatória SQS_OUTBOX_QUEUE_NAME não foi informada.',
    );
  });

  test('rejeita uma porta inválida', () => {
    const environment = { ...validEnvironment, APP_PORT: '70000' };

    expect(() => loadApplicationConfig(environment)).toThrow(
      'APP_PORT deve ser um número inteiro entre 1 e 65535.',
    );
  });

  test('rejeita um protocolo de endpoint SQS não suportado', () => {
    const environment = { ...validEnvironment, AWS_ENDPOINT: 'ftp://localhost:4566' };

    expect(() => loadApplicationConfig(environment)).toThrow(
      'AWS_ENDPOINT deve ser uma URL HTTP ou HTTPS válida.',
    );
  });

  test('permite configurar a URL do painel e rejeita protocolos não HTTP', () => {
    expect(loadApplicationConfig({
      ...validEnvironment,
      WEB_PANEL_URL: 'https://painel.exemplo.test',
    }).webPanelUrl).toBe('https://painel.exemplo.test');
    expect(() => loadApplicationConfig({
      ...validEnvironment,
      WEB_PANEL_URL: 'ftp://painel.exemplo.test',
    })).toThrow('WEB_PANEL_URL deve ser uma URL HTTP ou HTTPS válida.');
  });

  test('permite selecionar um schema isolado e valida seu identificador', () => {
    expect(loadApplicationConfig({
      ...validEnvironment,
      DATABASE_SCHEMA: 'teste_instancias_1',
    }).postgres.schema).toBe('teste_instancias_1');
    expect(() => loadApplicationConfig({
      ...validEnvironment,
      DATABASE_SCHEMA: 'schema-invalido',
    })).toThrow('DATABASE_SCHEMA deve começar com letra ou sublinhado');
  });
});
