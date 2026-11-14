/** Esta página interpreta apenas as métricas operacionais fixas do backend.
 * Assinatura: Leonardo de Souza da Luz
 */
export const TRANSACTION_STATUSES = [
  { key: 'PROCESSED', label: 'Processadas' },
  { key: 'REJECTED', label: 'Rejeitadas' },
  { key: 'PENDING_REFERENCE', label: 'Aguardando referência' },
  { key: 'PENDING', label: 'Em processamento' },
  { key: 'FAILED', label: 'Falhas' },
] as const;

export interface DashboardMetrics {
  readonly transactions: readonly {
    readonly status: string;
    readonly label: string;
    readonly count: number;
  }[];
  readonly deadLetterVisibleMessages: number | null;
  readonly outboxLagSeconds: number | null;
}

function metricValue(
  exposition: string,
  name: string,
  labelName?: string,
  labelValue?: string,
): number | null {
  const series = labelName && labelValue
    ? name + '{' + labelName + '="' + labelValue + '"}'
    : name;
  const line = exposition
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(series + ' '));
  if (!line) {
    return null;
  }
  const value = Number(line.slice(series.length + 1).trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseDashboardMetrics(exposition: string): DashboardMetrics {
  return {
    transactions: TRANSACTION_STATUSES.map(({ key, label }) => ({
      status: key,
      label,
      count: metricValue(exposition, 'wagering_transactions_total', 'status', key) ?? 0,
    })),
    deadLetterVisibleMessages: metricValue(exposition, 'sqs_dlq_visible_messages'),
    outboxLagSeconds: metricValue(exposition, 'outbox_lag_seconds'),
  };
}
