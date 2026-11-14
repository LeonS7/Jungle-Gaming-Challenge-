/**
 * Esta página verifica o backoff, o TTL e os estados da referência pendente.
 * Assinatura: Leonardo de Souza da Luz
 */
import { expect, test } from 'bun:test';
import {
  InvalidPendingReferenceRetryError,
  PendingReferenceRetry,
} from '../../../../src/domain/wagering/pending-reference-retry.js';

test('PendingReferenceRetry aplica backoff exponencial e limita cinco minutos', () => {
  const start = new Date('2026-11-13T20:00:00.000Z');
  const retry = PendingReferenceRetry.rehydrate({
    attempts: 0,
    nextAttemptAt: new Date(start.getTime() + 1000),
    expiresAt: new Date(start.getTime() + 24 * 60 * 60 * 1000),
  });

  expect([1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300]).toEqual(
    Array.from({ length: 11 }, () => retry.scheduleRetry(start).delaySeconds),
  );
  expect(retry.attempts).toBe(11);
  expect(retry.isExpired(start)).toBe(false);
});

test('PendingReferenceRetry reconhece o TTL e limita a próxima tentativa ao prazo', () => {
  const expiresAt = new Date('2026-11-13T20:00:10.000Z');
  const retry = PendingReferenceRetry.rehydrate({
    attempts: 0,
    nextAttemptAt: new Date('2026-11-13T20:00:01.000Z'),
    expiresAt,
  });
  const schedule = retry.scheduleRetry(new Date('2026-11-13T20:00:09.500Z'));

  expect(schedule.nextAttemptAt).toEqual(expiresAt);
  expect(retry.isExpired(expiresAt)).toBe(true);
  expect(() => retry.scheduleRetry(expiresAt)).toThrow(
    InvalidPendingReferenceRetryError,
  );
});

test('PendingReferenceRetry rejeita datas e tentativas persistidas inválidas', () => {
  expect(() => PendingReferenceRetry.rehydrate({
    attempts: -1,
    nextAttemptAt: new Date(),
    expiresAt: new Date(Date.now() + 1000),
  })).toThrow(InvalidPendingReferenceRetryError);
  expect(() => PendingReferenceRetry.rehydrate({
    attempts: 0,
    nextAttemptAt: new Date('invalid'),
    expiresAt: new Date(),
  })).toThrow(InvalidPendingReferenceRetryError);
});
