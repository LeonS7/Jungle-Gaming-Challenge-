/**
 * Esta página persiste somente o identificador da carteira selecionada.
 * Assinatura: Leonardo de Souza da Luz
 */
export const SELECTED_WALLET_STORAGE_KEY = 'jungle-gaming.selected-wallet.v1';

export type WalletContextStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readSelectedWalletId(storage: WalletContextStorage): string | null {
  return storage.getItem(SELECTED_WALLET_STORAGE_KEY);
}

export function saveSelectedWalletId(
  storage: WalletContextStorage,
  walletId: string,
): void {
  storage.setItem(SELECTED_WALLET_STORAGE_KEY, walletId);
}

export function removeSelectedWalletId(storage: WalletContextStorage): void {
  storage.removeItem(SELECTED_WALLET_STORAGE_KEY);
}
