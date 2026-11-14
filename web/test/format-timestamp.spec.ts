/** Esta página garante que a formatação usada no painel não interrompa a renderização. Assinatura: Leonardo de Souza da Luz */
import { expect, test } from 'bun:test';
import { formatTimestamp } from '../src/features/dashboard/format-timestamp';

test('formata Date e texto ISO sem opções Intl incompatíveis', () => {
  const dateResult = formatTimestamp(new Date('2026-11-14T16:00:00.000Z'));
  const stringResult = formatTimestamp('2026-11-14T16:00:00.000Z');

  expect(typeof dateResult).toBe('string');
  expect(dateResult.length).toBeGreaterThan(0);
  expect(typeof stringResult).toBe('string');
  expect(stringResult.length).toBeGreaterThan(0);
});
