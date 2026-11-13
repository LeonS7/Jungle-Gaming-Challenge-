/**
 * Esta página valida mensagens recebidas e monta o comando compartilhado de wagering.
 * Assinatura: Leonardo de Souza da Luz
 */
import { createHash } from 'node:crypto';
import type {
  InboxMessageIdentity,
  ProcessWagerCommand,
} from '../../application/wagering/process-wager.js';
import {
  InvalidWagerRequestError,
  parseWagerCommand,
  UnsupportedWagerKindError,
} from '../../application/wagering/parse-wager-command.js';
export interface ParsedWagerQueueMessage {
  readonly identity: InboxMessageIdentity;
  readonly command: ProcessWagerCommand;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidWagerRequestError(`${field} deve ser uma string não vazia.`);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  parent: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new InvalidWagerRequestError(`O campo ${parent}.${unknown} não é permitido.`);
  }
}

export function parseWagerQueueMessage(rawBody: string): ParsedWagerQueueMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new InvalidWagerRequestError('O corpo da mensagem não contém JSON válido.');
  }
  if (!isObject(parsed)) {
    throw new InvalidWagerRequestError('A mensagem deve ser um objeto JSON.');
  }
  rejectUnknownFields(
    parsed,
    ['messageId', 'type', 'occurredAt', 'data'],
    'mensagem',
  );
  const messageId = requireText(parsed.messageId, 'messageId');
  if (parsed.type !== 'WagerTransactionRequested') {
    throw new UnsupportedWagerKindError();
  }
  const occurredAt = requireText(parsed.occurredAt, 'occurredAt');
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidWagerRequestError('occurredAt deve ser uma data ISO-8601 válida.');
  }
  if (!isObject(parsed.data)) {
    throw new InvalidWagerRequestError('data deve ser um objeto JSON.');
  }
  const data = { ...parsed.data };
  const idempotencyKey = requireText(data.idempotencyKey, 'idempotencyKey');
  delete data.idempotencyKey;
  const command = parseWagerCommand(data, idempotencyKey, 'idempotencyKey');
  const payloadHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');

  return {
    identity: {
      consumerName: 'wager-processor-v1',
      messageId,
      payloadHash,
    },
    command,
  };
}

export { InvalidWagerRequestError, UnsupportedWagerKindError };
