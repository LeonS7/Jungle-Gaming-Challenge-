/** Esta página consulta saúde e métricas pela API HTTP do backend.
 * Assinatura: Leonardo de Souza da Luz
 */
import { parseDashboardMetrics } from '../features/dashboard/dashboard-metrics';

export interface HealthState {
  readonly state: 'checking' | 'ok' | 'error';
  readonly detail?: string;
}

export interface DashboardSnapshot {
  readonly application: HealthState;
  readonly postgres: HealthState;
  readonly sqs: HealthState;
  readonly metrics: ReturnType<typeof parseDashboardMetrics> | null;
  readonly metricsError?: string;
  readonly updatedAt: Date;
}

interface HealthResponse {
  readonly status?: unknown;
  readonly dependencies?: {
    readonly postgres?: unknown;
    readonly sqs?: unknown;
  };
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const API_REQUEST_TIMEOUT_MILLISECONDS = 5_000;

function dependencyState(value: unknown): HealthState {
  if (value === 'ok') {
    return { state: 'ok', detail: 'Disponível' };
  }
  if (value === 'error') {
    return { state: 'error', detail: 'Indisponível' };
  }
  return { state: 'error', detail: 'Não foi possível verificar' };
}

async function requestHealth(path: string): Promise<{
  readonly responseOk: boolean;
  readonly body: HealthResponse | null;
}> {
  const response = await fetch(API_BASE_URL + path, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MILLISECONDS),
  });
  let body: HealthResponse | null = null;
  try {
    body = await response.json() as HealthResponse;
  } catch {
    // A tela informa a falha sem exibir conteúdo inesperado recebido da API.
  }
  return { responseOk: response.ok, body };
}

async function readApplicationHealth(): Promise<HealthState> {
  try {
    const result = await requestHealth('/health/live');
    return result.responseOk && result.body?.status === 'ok'
      ? { state: 'ok', detail: 'Processo respondendo' }
      : { state: 'error', detail: 'Processo sem resposta saudável' };
  } catch {
    return { state: 'error', detail: 'API inacessível' };
  }
}

async function readDependenciesHealth(): Promise<{
  readonly postgres: HealthState;
  readonly sqs: HealthState;
}> {
  try {
    const result = await requestHealth('/health/ready');
    if (!result.body?.dependencies) {
      const unavailable = { state: 'error', detail: 'Readiness sem detalhes' } as const;
      return { postgres: unavailable, sqs: unavailable };
    }
    return {
      postgres: dependencyState(result.body.dependencies.postgres),
      sqs: dependencyState(result.body.dependencies.sqs),
    };
  } catch {
    const unavailable = { state: 'error', detail: 'Readiness inacessível' } as const;
    return { postgres: unavailable, sqs: unavailable };
  }
}

async function readMetrics(): Promise<{
  readonly metrics: ReturnType<typeof parseDashboardMetrics> | null;
  readonly error?: string;
}> {
  try {
    const response = await fetch(API_BASE_URL + '/metrics', {
      headers: { accept: 'text/plain' },
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) {
      return { metrics: null, error: 'A API não conseguiu fornecer as métricas.' };
    }
    return { metrics: parseDashboardMetrics(await response.text()) };
  } catch {
    return { metrics: null, error: 'Não foi possível consultar as métricas da API.' };
  }
}

export async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  const [application, dependencies, metricsResult] = await Promise.all([
    readApplicationHealth(),
    readDependenciesHealth(),
    readMetrics(),
  ]);

  return {
    application,
    postgres: dependencies.postgres,
    sqs: dependencies.sqs,
    metrics: metricsResult.metrics,
    ...(metricsResult.error ? { metricsError: metricsResult.error } : {}),
    updatedAt: new Date(),
  };
}
