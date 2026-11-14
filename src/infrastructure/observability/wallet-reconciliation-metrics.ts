/**
 * Esta página mantém e expõe a métrica operacional de divergências de reconciliação.
 * Assinatura: Leonardo de Souza da Luz
 */
import type { WalletReconciliationMetricsPort } from '../../application/wallets/wallet-reconciliation.port.js';

export class WalletReconciliationMetrics implements WalletReconciliationMetricsPort {
  private divergences = 0;

  recordDivergence(): void {
    this.divergences += 1;
  }

  renderPrometheus(): string {
    return [
      '# HELP wallet_reconciliation_divergences_total Reconciliações com saldo divergente.',
      '# TYPE wallet_reconciliation_divergences_total counter',
      `wallet_reconciliation_divergences_total ${this.divergences}`,
      '',
    ].join('\n');
  }
}
