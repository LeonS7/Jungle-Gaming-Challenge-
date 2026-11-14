/** Esta página testa a leitura de métricas do dashboard sem tratar valores como dinheiro.
 * Assinatura: Leonardo de Souza da Luz
 */
import { describe, expect, test } from 'bun:test';
import { parseDashboardMetrics } from '../src/features/dashboard/dashboard-metrics';

describe('leitura de métricas do dashboard', () => {
  test('lê somente séries conhecidas e preserva contadores como dados operacionais', () => {
    const metrics = parseDashboardMetrics([
      'wagering_transactions_total{status="PROCESSED"} 14',
      'wagering_transactions_total{status="REJECTED"} 2',
      'sqs_dlq_visible_messages 3',
      'outbox_lag_seconds 1.5',
      'wagering_transactions_total{status="UNKNOWN"} 900',
    ].join('\n'));

    expect(metrics.transactions).toEqual([
      { status: 'PROCESSED', label: 'Processadas', count: 14 },
      { status: 'REJECTED', label: 'Rejeitadas', count: 2 },
      { status: 'PENDING_REFERENCE', label: 'Aguardando referência', count: 0 },
      { status: 'PENDING', label: 'Em processamento', count: 0 },
      { status: 'FAILED', label: 'Falhas', count: 0 },
    ]);
    expect(metrics.deadLetterVisibleMessages).toBe(3);
    expect(metrics.outboxLagSeconds).toBe(1.5);
  });

  test('mantém métricas ausentes ou malformadas como indisponíveis', () => {
    const metrics = parseDashboardMetrics([
      'sqs_dlq_visible_messages NaN',
      'outbox_lag_seconds -1',
    ].join('\n'));

    expect(metrics.deadLetterVisibleMessages).toBeNull();
    expect(metrics.outboxLagSeconds).toBeNull();
  });
});
