/**
 * Esta página consulta uma transação por ID interno ou por identidade do provedor.
 * Assinatura: Leonardo de Souza da Luz
 */
import type {
  WagerReadPort,
  WagerTransactionReadModel,
} from './wager-read.port.js';

export class WagerTransactionNotFoundError extends Error {
  constructor() {
    super('A transação solicitada não existe.');
    this.name = 'WagerTransactionNotFoundError';
  }
}

export class GetWagerTransaction {
  constructor(private readonly readPort: WagerReadPort) {}

  async byId(transactionId: string): Promise<WagerTransactionReadModel> {
    const transaction = await this.readPort.findById(transactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError();
    }
    return transaction;
  }

  async byProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionReadModel> {
    const transaction = await this.readPort.findByProviderExternalId(
      providerId,
      externalTransactionId,
    );
    if (!transaction) {
      throw new WagerTransactionNotFoundError();
    }
    return transaction;
  }
}
