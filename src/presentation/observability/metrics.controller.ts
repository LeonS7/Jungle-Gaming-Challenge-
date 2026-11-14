/**
 * Esta página expõe as métricas operacionais em formato textual Prometheus.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Controller, Get, Header } from '@nestjs/common';
import { WalletReconciliationMetrics } from '../../infrastructure/observability/wallet-reconciliation-metrics.js';
import { WageringMetrics } from '../../infrastructure/observability/wagering-metrics.js';

@Controller()
export class MetricsController {
  constructor(
    private readonly wageringMetrics: WageringMetrics,
    private readonly reconciliationMetrics: WalletReconciliationMetrics,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  readMetrics(): string {
    return this.wageringMetrics.renderPrometheus()
      + this.reconciliationMetrics.renderPrometheus();
  }
}
