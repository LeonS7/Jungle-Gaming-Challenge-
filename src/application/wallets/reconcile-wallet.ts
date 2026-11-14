/**
 * Esta página compara o saldo persistido com a soma exata do ledger da carteira.
 * Assinatura: Leonardo de Souza da Luz
 */
import { WalletNotFoundError } from './get-wallet.js';
import type {
  WalletReconciliationMetricsPort,
  WalletReconciliationReadPort,
} from './wallet-reconciliation.port.js';
import { Money } from '../../domain/money/money.js';

export interface WalletReconciliationResult {
  readonly walletId: string;
  readonly storedBalance: ReturnType<Money['toJSON']>;
  readonly calculatedBalance: ReturnType<Money['toJSON']>;
  /** Diferença é saldo persistido menos saldo reconstituído do ledger. */
  readonly difference: ReturnType<Money['toJSON']>;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export class ReconcileWallet {
  constructor(
    private readonly readPort: WalletReconciliationReadPort,
    private readonly metrics: WalletReconciliationMetricsPort,
  ) {}

  async execute(walletId: string): Promise<WalletReconciliationResult> {
    const snapshot = await this.readPort.findSnapshot(walletId);
    if (!snapshot) {
      throw new WalletNotFoundError();
    }
    const storedBalance = Money.from({
      amount: snapshot.storedBalance,
      currency: snapshot.currency,
    });
    const calculatedBalance = Money.from({
      amount: snapshot.calculatedBalance,
      currency: snapshot.currency,
    });
    const difference = storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.recordDivergence();
    }
    return {
      walletId: snapshot.walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
