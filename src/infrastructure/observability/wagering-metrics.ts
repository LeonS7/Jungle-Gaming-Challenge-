/**
 * Esta página agrega contadores, histogramas e gauges operacionais por processo.
 * Assinatura: Leonardo de Souza da Luz
 */
import type {
  DuplicateMetricSource,
  LockConflictType,
  OperationalMetricsPort,
  RetryMetricSource,
} from '../../application/observability/operational-metrics.port.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';

const HISTOGRAM_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5] as const;
const TRANSACTION_STATUSES = [
  WagerTransactionStatus.Pending,
  WagerTransactionStatus.PendingReference,
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
] as const;
const DUPLICATE_SOURCES = ['idempotency', 'inbox', 'provider_transaction'] as const;
const RETRY_SOURCES = ['pending_reference', 'sqs', 'outbox'] as const;
const LOCK_CONFLICT_TYPES = ['deadlock', 'serialization', 'lock_not_available'] as const;

class SecondsHistogram {
  private readonly bucketCounts = HISTOGRAM_BUCKETS.map(() => 0);
  private count = 0;
  private sum = 0;

  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    this.count += 1;
    this.sum += value;
    HISTOGRAM_BUCKETS.forEach((bound, index) => {
      if (value <= bound) {
        this.bucketCounts[index] = this.bucketCounts[index]! + 1;
      }
    });
  }

  render(metricName: string): string[] {
    const rows = HISTOGRAM_BUCKETS.map((bound, index) =>
      metricName + '_bucket{le="' + bound + '"} ' + this.bucketCounts[index],
    );
    rows.push(metricName + '_bucket{le="+Inf"} ' + this.count);
    rows.push(metricName + '_sum ' + this.sum);
    rows.push(metricName + '_count ' + this.count);
    return rows;
  }
}

/** Métricas em memória são observabilidade local, nunca estado de negócio. */
export class WageringMetrics implements OperationalMetricsPort {
  private readonly transactionCounts: Record<WagerTransactionStatus, number> = {
    [WagerTransactionStatus.Pending]: 0,
    [WagerTransactionStatus.PendingReference]: 0,
    [WagerTransactionStatus.Processed]: 0,
    [WagerTransactionStatus.Rejected]: 0,
    [WagerTransactionStatus.Failed]: 0,
  };
  private readonly duplicateCounts: Record<DuplicateMetricSource, number> = {
    idempotency: 0,
    inbox: 0,
    provider_transaction: 0,
  };
  private readonly retryCounts: Record<RetryMetricSource, number> = {
    pending_reference: 0,
    sqs: 0,
    outbox: 0,
  };
  private readonly lockConflictCounts: Record<LockConflictType, number> = {
    deadlock: 0,
    serialization: 0,
    lock_not_available: 0,
  };
  private readonly walletLockWait = new SecondsHistogram();
  private readonly processingDuration = new SecondsHistogram();
  private deadLetterVisibleMessages = 0;
  private outboxLagSeconds = 0;

  recordTransactionStatus(status: WagerTransactionStatus): void {
    this.transactionCounts[status] += 1;
  }

  recordDuplicate(source: DuplicateMetricSource): void {
    this.duplicateCounts[source] += 1;
  }

  recordRetry(source: RetryMetricSource): void {
    this.retryCounts[source] += 1;
  }

  setDeadLetterVisibleMessages(count: number): void {
    if (Number.isSafeInteger(count) && count >= 0) {
      this.deadLetterVisibleMessages = count;
    }
  }

  recordWalletLockWait(seconds: number): void {
    this.walletLockWait.observe(seconds);
  }

  recordLockConflict(type: LockConflictType): void {
    this.lockConflictCounts[type] += 1;
  }

  setOutboxLagSeconds(seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) {
      this.outboxLagSeconds = seconds;
    }
  }

  recordProcessingDuration(seconds: number): void {
    this.processingDuration.observe(seconds);
  }

  renderPrometheus(): string {
    const rows = [
      '# HELP wagering_transactions_total Processamentos financeiros observados por estado.',
      '# TYPE wagering_transactions_total counter',
      ...TRANSACTION_STATUSES.map(
        (status) => 'wagering_transactions_total{status="' + status + '"} ' + this.transactionCounts[status],
      ),
      '# HELP wagering_duplicates_total Repetições detectadas pela idempotência persistida.',
      '# TYPE wagering_duplicates_total counter',
      ...DUPLICATE_SOURCES.map(
        (source) => 'wagering_duplicates_total{source="' + source + '"} ' + this.duplicateCounts[source],
      ),
      '# HELP wagering_retries_total Tentativas de retry observadas por origem.',
      '# TYPE wagering_retries_total counter',
      ...RETRY_SOURCES.map(
        (source) => 'wagering_retries_total{source="' + source + '"} ' + this.retryCounts[source],
      ),
      '# HELP sqs_dlq_visible_messages Mensagens visíveis atualmente na DLQ do SQS.',
      '# TYPE sqs_dlq_visible_messages gauge',
      'sqs_dlq_visible_messages ' + this.deadLetterVisibleMessages,
      '# HELP wagering_lock_conflicts_total Conflitos PostgreSQL de deadlock, serialização ou lock indisponível.',
      '# TYPE wagering_lock_conflicts_total counter',
      ...LOCK_CONFLICT_TYPES.map(
        (type) => 'wagering_lock_conflicts_total{type="' + type + '"} ' + this.lockConflictCounts[type],
      ),
      '# HELP wagering_wallet_lock_acquisition_seconds Duração total da consulta que adquire o lock da carteira.',
      '# TYPE wagering_wallet_lock_acquisition_seconds histogram',
      ...this.walletLockWait.render('wagering_wallet_lock_acquisition_seconds'),
      '# HELP outbox_lag_seconds Idade da mensagem pendente mais antiga da outbox.',
      '# TYPE outbox_lag_seconds gauge',
      'outbox_lag_seconds ' + this.outboxLagSeconds,
      '# HELP wagering_processing_duration_seconds Duração de uma chamada do caso de uso financeiro.',
      '# TYPE wagering_processing_duration_seconds histogram',
      ...this.processingDuration.render('wagering_processing_duration_seconds'),
      '',
    ];
    return rows.join('\n');
  }
}
