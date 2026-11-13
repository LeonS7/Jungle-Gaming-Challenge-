/**
 * Esta página grava envelopes na outbox usando o contexto da transação PostgreSQL atual.
 * Assinatura: Leonardo de Souza da Luz
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxMessageToAppend } from '../../application/outbox/integration-events.js';

function qualifiedTable(schema: string | undefined, table: string): string {
  if (!schema) {
    return `"${table}"`;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('O nome do schema PostgreSQL contém caracteres inválidos.');
  }
  return `"${schema}"."${table}"`;
}

export async function insertOutboxMessage(
  entityManager: EntityManager,
  schema: string | undefined,
  message: OutboxMessageToAppend,
): Promise<void> {
  const { event } = message;
  await entityManager.getConnection().execute(
    `insert into ${qualifiedTable(schema, 'outbox_messages')} (
      "id", "transaction_id", "sequence_number", "aggregate_id", "event_type", "correlation_id",
      "version", "payload", "occurred_at"
    ) values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)`,
    [
      event.eventId,
      message.transactionId,
      message.sequenceNumber,
      event.aggregateId,
      event.eventType,
      event.correlationId,
      event.version,
      JSON.stringify(event),
      event.occurredAt,
    ],
    'all',
    entityManager.getTransactionContext(),
  );
}
