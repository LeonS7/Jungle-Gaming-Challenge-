/**
 * Esta página define as medições operacionais sem acoplar Application ao Prometheus.
 * Assinatura: Leonardo de Souza da Luz
 */
import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction.js';

export type DuplicateMetricSource = 'idempotency' | 'inbox' | 'provider_transaction';
export type RetryMetricSource = 'pending_reference' | 'sqs' | 'outbox';
export type LockConflictType = 'deadlock' | 'serialization' | 'lock_not_available';

export interface OperationalMetricsPort {
  recordTransactionStatus(status: WagerTransactionStatus): void;
  recordDuplicate(source: DuplicateMetricSource): void;
  recordRetry(source: RetryMetricSource): void;
  setDeadLetterVisibleMessages(count: number): void;
  recordWalletLockWait(seconds: number): void;
  recordLockConflict(type: LockConflictType): void;
  setOutboxLagSeconds(seconds: number): void;
  recordProcessingDuration(seconds: number): void;
}
