/**
 * Esta página reclama eventos com lease e atualiza entrega no PostgreSQL.
 * Assinatura: Leonardo de Souza da Luz
 */
import { randomUUID } from 'node:crypto';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import type {
  ClaimedOutboxMessage,
  OutboxPublishingPersistencePort,
} from '../../application/outbox/outbox-publishing.port.js';

interface OutboxMessageRow {
  readonly id: string;
  readonly transactionId: string;
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly payload: string;
  readonly attempts: number;
  readonly nextAttemptAt: Date | string;
}

function qualifiedTable(schema: string | undefined): string {
  if (!schema) {
    return '"outbox_messages"';
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error('O nome do schema PostgreSQL contém caracteres inválidos.');
  }
  return `"${schema}"."outbox_messages"`;
}

function parseDatabaseDate(value: Date | string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('O PostgreSQL retornou uma data inválida para a outbox.');
  }
  return parsed;
}

function parsePayload(value: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('O PostgreSQL retornou um envelope inválido para a outbox.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('O envelope persistido da outbox precisa ser um objeto JSON.');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export class PostgresOutboxPublishing implements OutboxPublishingPersistencePort {
  constructor(
    private readonly orm: MikroORM,
    private readonly schema?: string,
  ) {}

  async getOutboxLagSeconds(): Promise<number> {
    const entityManager = this.orm.em.fork();
    try {
      const rows = await entityManager.getConnection().execute(
        `select coalesce(
           extract(epoch from (now() - min("created_at"))),
           0
         )::text as "lagSeconds"
         from ${qualifiedTable(this.schema)}
         where "published_at" is null`,
        [],
        'all',
      );
      const value = Number((rows[0] as { readonly lagSeconds: string }).lagSeconds);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('O PostgreSQL retornou um atraso inválido para a outbox.');
      }
      return value;
    } finally {
      entityManager.clear();
    }
  }

  async claimDueMessages(
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly ClaimedOutboxMessage[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('O limite de claim precisa ser um inteiro positivo.');
    }
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new RangeError('A duração do lease precisa ser um inteiro positivo.');
    }

    const outbox = qualifiedTable(this.schema);
    return this.orm.em.transactional(async (entityManager) => {
      const context = entityManager.getTransactionContext();
      const rows = await entityManager.getConnection().execute(
        `select messages."id"::text as "id",
                messages."transaction_id"::text as "transactionId",
                messages."sequence_number" as "sequenceNumber",
                messages."event_type" as "eventType",
                messages."payload"::text as "payload",
                messages."attempts" as "attempts",
                messages."next_attempt_at" as "nextAttemptAt"
         from ${outbox} as messages
         where messages."published_at" is null
           and messages."next_attempt_at" <= now()
           and (
             messages."locked_until" is null
             or messages."locked_until" <= now()
           )
           and not exists (
             select 1 from ${outbox} as earlier
             where earlier."transaction_id" = messages."transaction_id"
               and earlier."sequence_number" < messages."sequence_number"
               and earlier."published_at" is null
           )
         order by messages."next_attempt_at", messages."created_at", messages."id"
         limit ?
         for update of messages skip locked`,
        [limit],
        'all',
        context,
      ) as unknown as OutboxMessageRow[];

      const claims: ClaimedOutboxMessage[] = [];
      for (const row of rows) {
        const lockToken = randomUUID();
        const locked = await entityManager.getConnection().execute(
          `update ${outbox}
           set "lock_token" = ?,
               "locked_until" = now() + (? * interval '1 second')
           where "id" = ? and "published_at" is null
           returning "id"`,
          [lockToken, leaseSeconds, row.id],
          'all',
          context,
        );
        if (locked.length !== 1) {
          throw new Error('A mensagem selecionada não pôde ser reclamada.');
        }

        claims.push({
          id: row.id,
          transactionId: row.transactionId,
          sequenceNumber: row.sequenceNumber,
          eventType: row.eventType,
          payload: parsePayload(row.payload),
          attempts: row.attempts,
          nextAttemptAt: parseDatabaseDate(row.nextAttemptAt),
          lockToken,
        });
      }
      return claims;
    });
  }

  async markPublished(
    id: string,
    lockToken: string,
    publishedAt: Date,
  ): Promise<boolean> {
    const rows = await this.orm.em.transactional(async (entityManager) =>
      entityManager.getConnection().execute(
        `update ${qualifiedTable(this.schema)}
         set "published_at" = ?, "lock_token" = null, "locked_until" = null
         where "id" = ? and "lock_token" = ? and "published_at" is null
         returning "id"`,
        [publishedAt, id, lockToken],
        'all',
        entityManager.getTransactionContext(),
      ),
    );
    return rows.length === 1;
  }

  async scheduleRetry(
    id: string,
    lockToken: string,
    attempts: number,
    delaySeconds: number,
  ): Promise<boolean> {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1) {
      throw new RangeError('O intervalo de retry precisa ser positivo.');
    }
    const rows = await this.orm.em.transactional(async (entityManager) =>
      entityManager.getConnection().execute(
        `update ${qualifiedTable(this.schema)}
         set "attempts" = ?,
             "next_attempt_at" = now() + (? * interval '1 second'),
             "lock_token" = null, "locked_until" = null
         where "id" = ? and "lock_token" = ? and "published_at" is null
         returning "id"`,
        [attempts, delaySeconds, id, lockToken],
        'all',
        entityManager.getTransactionContext(),
      ),
    );
    return rows.length === 1;
  }
}
