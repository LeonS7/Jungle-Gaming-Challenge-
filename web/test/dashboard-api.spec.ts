/** Esta página verifica que o painel conclua a leitura dos estados da API.
 * Assinatura: Leonardo de Souza da Luz
 */
import { describe, expect, test } from 'bun:test';
import { loadDashboardSnapshot } from '../src/api/dashboard-api';

describe('carregamento dos estados do painel', () => {
  test('atualiza saúde, dependências e métricas quando a API responde', async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const requestPaths: string[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        const path = String(input);
        requestPaths.push(path);
        if (path.endsWith('/health/live')) {
          return Response.json({ status: 'ok' });
        }
        if (path.endsWith('/health/ready')) {
          return Response.json({
            status: 'ok',
            dependencies: { postgres: 'ok', sqs: 'ok' },
          });
        }
        return new Response('sqs_dlq_visible_messages 0\noutbox_lag_seconds 0\n', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    });

    try {
      const snapshot = await loadDashboardSnapshot();

      expect(snapshot.application.state).toBe('ok');
      expect(snapshot.postgres.state).toBe('ok');
      expect(snapshot.sqs.state).toBe('ok');
      expect(snapshot.metrics?.deadLetterVisibleMessages).toBe(0);
      expect(requestPaths).toHaveLength(3);
    } finally {
      if (originalFetch) {
        Object.defineProperty(globalThis, 'fetch', originalFetch);
      }
    }
  });
});
