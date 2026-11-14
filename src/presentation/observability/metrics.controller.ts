/**
 * Esta página expõe as métricas operacionais em formato textual Prometheus.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Controller, Get, Header } from '@nestjs/common';
import { WalletReconciliationMetrics } from '../../infrastructure/observability/wallet-reconciliation-metrics.js';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: WalletReconciliationMetrics) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  readMetrics(): string {
    return this.metrics.renderPrometheus();
  }
}
