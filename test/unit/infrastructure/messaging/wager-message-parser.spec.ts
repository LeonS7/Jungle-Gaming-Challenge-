/**
 * Esta página valida o contrato SQS e o comando compartilhado de wagering.
 * Assinatura: Leonardo de Souza da Luz
 */
import { expect, test } from 'bun:test';
import {
  parseWagerQueueMessage,
} from '../../../../src/infrastructure/messaging/wager-message-parser.js';

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: 'mensagem-sqs-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-11-13T15:00:00.000Z',
    data: {
      providerId: 'provedor-a',
      externalTransactionId: 'aposta-sqs-1',
      idempotencyKey: 'provedor-a:aposta-sqs-1',
      playerId: 'jogador-1',
      walletId: '63d44077-6d43-46a1-a1a3-6494dc9c70f0',
      roundId: 'rodada-sqs-1',
      gameId: 'jogo-sqs-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
    ...overrides,
  });
}

test('converte mensagem válida usando a mesma validação e hash do endpoint HTTP', () => {
  const raw = body();
  const parsed = parseWagerQueueMessage(raw);

  expect(parsed.identity).toMatchObject({
    consumerName: 'wager-processor-v1',
    messageId: 'mensagem-sqs-1',
  });
  expect(parsed.identity.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  expect(parsed.command.idempotencyKey).toBe('provedor-a:aposta-sqs-1');
  expect(parsed.command.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  expect(parseWagerQueueMessage(raw).identity.payloadHash)
    .toBe(parsed.identity.payloadHash);
});

test('rejeita JSON, tipo, data e campos desconhecidos da mensagem', () => {
  expect(() => parseWagerQueueMessage('{')).toThrow('JSON válido');
  expect(() => parseWagerQueueMessage(body({ type: 'OutroEvento' })))
    .toThrow('tipo de transação');
  expect(() => parseWagerQueueMessage(body({ occurredAt: 'ontem' })))
    .toThrow('ISO-8601');
  expect(() => parseWagerQueueMessage(body({ campoSurpresa: true })))
    .toThrow('não é permitido');
});
