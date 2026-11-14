/**
 * Esta página verifica retry, backoff e publicação da mensagem de outbox.
 * Assinatura: Leonardo de Souza da Luz
 */
import { expect, test } from 'bun:test';
import {
  InvalidOutboxMessageError,
  InvalidOutboxMessageStateError,
  OutboxMessage,
} from '../../../../src/domain/outbox/outbox-message.js';

test('OutboxMessage programa backoff exponencial limitado a sessenta segundos', () => {
  const now = new Date('2026-11-13T20:00:00.000Z');
  const message = OutboxMessage.rehydrate({
    id: 'evento-1',
    attempts: 0,
    nextAttemptAt: now,
  });

  expect(message.isDue(now)).toBe(true);
  expect([1, 2, 4, 8, 16, 32, 60, 60]).toEqual(
    Array.from({ length: 8 }, () => message.scheduleRetry(now).delaySeconds),
  );
  expect(message.attempts).toBe(8);
  expect(message.nextAttemptAt.toISOString()).toBe('2026-11-13T20:01:00.000Z');
});

test('OutboxMessage marca a publicação uma vez e retorna cópias das datas', () => {
  const publishedAt = new Date('2026-11-13T20:00:01.000Z');
  const message = OutboxMessage.rehydrate({
    id: 'evento-2',
    attempts: 1,
    nextAttemptAt: new Date('2026-11-13T20:00:00.000Z'),
  });

  message.markPublished(publishedAt);
  publishedAt.setUTCFullYear(2000);

  expect(message.isPending()).toBe(false);
  expect(message.publishedAt?.toISOString()).toBe('2026-11-13T20:00:01.000Z');
  expect(() => message.scheduleRetry(new Date())).toThrow(
    InvalidOutboxMessageStateError,
  );
  expect(() => message.markPublished(new Date())).toThrow(
    InvalidOutboxMessageStateError,
  );
});

test('OutboxMessage rejeita estado persistido inválido', () => {
  expect(() => OutboxMessage.rehydrate({
    id: '',
    attempts: 0,
    nextAttemptAt: new Date(),
  })).toThrow(InvalidOutboxMessageError);
  expect(() => OutboxMessage.rehydrate({
    id: 'evento-3',
    attempts: -1,
    nextAttemptAt: new Date(),
  })).toThrow(InvalidOutboxMessageError);
});
