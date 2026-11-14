/**
 * Esta página define as portas de leitura e métrica da reconciliação de carteira.
 * Assinatura: Leonardo de Souza da Luz
 */
export interface WalletReconciliationSnapshot {
  readonly walletId: string;
  readonly currency: string;
  readonly storedBalance: string;
  readonly calculatedBalance: string;
  readonly checkedEntries: number;
}

export interface WalletReconciliationReadPort {
  findSnapshot(walletId: string): Promise<WalletReconciliationSnapshot | null>;
}

export interface WalletReconciliationMetricsPort {
  recordDivergence(): void;
}
