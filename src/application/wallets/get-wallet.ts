/**
 * Esta página consulta uma carteira sem alterar seu estado financeiro.
 * Assinatura: Leonardo de Souza da Luz
 */
import type { WalletReadModel, WalletReadPort } from './wallet-read.port.js';

export class WalletNotFoundError extends Error {
  constructor() {
    super('A carteira solicitada não existe.');
    this.name = 'WalletNotFoundError';
  }
}

export class GetWallet {
  constructor(private readonly readPort: WalletReadPort) {}

  async execute(walletId: string): Promise<WalletReadModel> {
    const wallet = await this.readPort.findWalletById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    return wallet;
  }
}
