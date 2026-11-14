/**
 * Esta página classifica erros PostgreSQL compartilhados pelos adapters.
 * Assinatura: Leonardo de Souza da Luz
 */
export interface PostgreSqlErrorMetadata {
  readonly code?: string;
  readonly constraint?: string;
}

export function readPostgreSqlErrorMetadata(error: unknown): PostgreSqlErrorMetadata {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && typeof current === 'object' && current !== null;
    depth += 1
  ) {
    const candidate = current as Record<string, unknown>;
    const metadata: PostgreSqlErrorMetadata = {
      ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
      ...(typeof candidate.constraint === 'string'
        ? { constraint: candidate.constraint }
        : {}),
    };
    if (metadata.code || metadata.constraint) {
      return metadata;
    }
    current = candidate.cause;
  }

  return {};
}

export function isTransientPostgreSqlFailure(error: unknown): boolean {
  const code = readPostgreSqlErrorMetadata(error).code;
  if (!code) {
    return false;
  }

  return (
    code.startsWith('08') ||
    code.startsWith('40') ||
    code === '55P03' ||
    code === '53300' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE'
  );
}
