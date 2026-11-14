/**
 * Esta página verifica a exposição Prometheus e os limites de cardinalidade das métricas.
 * Assinatura: Leonardo de Souza da Luz
 */
import { expect, test } from 'bun:test';
import { WageringMetrics } from '../../../../src/infrastructure/observability/wagering-metrics.js';
import { WagerTransactionStatus } from '../../../../src/domain/wagering/wager-transaction.js';

test('WageringMetrics expõe contadores, gauges e histogramas sem rótulos variáveis', () => {
  const metrics = new WageringMetrics();
  metrics.recordTransactionStatus(WagerTransactionStatus.Processed);
  metrics.recordDuplicate('idempotency');
  metrics.recordDuplicate('provider_transaction');
  metrics.recordRetry('outbox');
  metrics.setDeadLetterVisibleMessages(3);
  metrics.recordWalletLockWait(0.01);
  metrics.recordLockConflict('deadlock');
  metrics.setOutboxLagSeconds(2.5);
  metrics.recordProcessingDuration(0.25);

  const output = metrics.renderPrometheus();
  expect(output).toContain('wagering_transactions_total{status="PROCESSED"} 1');
  expect(output).toContain('wagering_duplicates_total{source="idempotency"} 1');
  expect(output).toContain('wagering_duplicates_total{source="provider_transaction"} 1');
  expect(output).toContain('wagering_retries_total{source="outbox"} 1');
  expect(output).toContain('sqs_dlq_visible_messages 3');
  expect(output).toContain('wagering_lock_conflicts_total{type="deadlock"} 1');
  expect(output).toContain('wagering_wallet_lock_acquisition_seconds_count 1');
  expect(output).toContain('outbox_lag_seconds 2.5');
  expect(output).toContain('wagering_processing_duration_seconds_count 1');
  expect(output).not.toContain('walletId');
  expect(output).not.toContain('providerId');
});
