/**
 * Esta página verifica identidade, imutabilidade temporal e transições da inbox.
 * Assinatura: Leonardo de Souza da Luz
 */
import { expect, test } from 'bun:test';
import {
  InboxMessage,
  InvalidInboxMessageStateError,
} from '../../../../src/domain/messaging/inbox-message.js';

test('InboxMessage valida a identidade, copia datas e marca processamento uma vez', () => {
  const receivedAt = new Date('2026-11-13T12:00:00.000Z');
  const message = InboxMessage.receive({
    consumerName: 'wager-processor',
    messageId: 'mensagem-1',
    payloadHash: 'a'.repeat(64),
    receivedAt,
  });
  receivedAt.setUTCFullYear(2000);
  const processedAt = new Date('2026-11-13T12:00:01.000Z');
  message.markProcessed(processedAt);
  processedAt.setUTCFullYear(2000);

  expect(message.isProcessed()).toBe(true);
  expect(message.receivedAt.toISOString()).toBe('2026-11-13T12:00:00.000Z');
  expect(message.processedAt?.toISOString()).toBe('2026-11-13T12:00:01.000Z');
  expect(() => message.markProcessed(new Date())).toThrow(
    InvalidInboxMessageStateError,
  );
});

test('InboxMessage rejeita identificadores vazios, hash inválido e data inválida', () => {
  expect(() => InboxMessage.receive({
    consumerName: ' ',
    messageId: 'mensagem-1',
    payloadHash: 'a'.repeat(64),
  })).toThrow('consumerName');
  expect(() => InboxMessage.receive({
    consumerName: 'wager-processor',
    messageId: 'mensagem-1',
    payloadHash: 'hash-inválido',
  })).toThrow('SHA-256');
  expect(() => InboxMessage.receive({
    consumerName: 'wager-processor',
    messageId: 'mensagem-1',
    payloadHash: 'a'.repeat(64),
    receivedAt: new Date(Number.NaN),
  })).toThrow('receivedAt');
});

test('InboxMessage.rehydrate recompõe o estado já processado sem nova transição', () => {
  const message = InboxMessage.rehydrate({
    consumerName: 'wager-processor',
    messageId: 'mensagem-2',
    payloadHash: 'b'.repeat(64),
    receivedAt: new Date('2026-11-13T12:00:00.000Z'),
    processedAt: new Date('2026-11-13T12:00:02.000Z'),
  });

  expect(message.isProcessed()).toBe(true);
  expect(message.processedAt?.toISOString()).toBe('2026-11-13T12:00:02.000Z');
});
