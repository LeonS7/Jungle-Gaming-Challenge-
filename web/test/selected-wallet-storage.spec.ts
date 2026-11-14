/** Esta página testa a persistência local do identificador de carteira, sem guardar estado financeiro.
 * Assinatura: Leonardo de Souza da Luz
 */
import { expect, test } from 'bun:test';
import {
  readSelectedWalletId,
  removeSelectedWalletId,
  saveSelectedWalletId,
  SELECTED_WALLET_STORAGE_KEY,
} from '../src/features/wallets/selected-wallet-storage';

test('armazena, lê e remove somente o identificador selecionado', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const walletId = '11111111-1111-4111-8111-111111111111';

  expect(readSelectedWalletId(storage)).toBeNull();
  saveSelectedWalletId(storage, walletId);
  expect(values.size).toBe(1);
  expect(values.get(SELECTED_WALLET_STORAGE_KEY)).toBe(walletId);
  expect(readSelectedWalletId(storage)).toBe(walletId);
  removeSelectedWalletId(storage);
  expect(readSelectedWalletId(storage)).toBeNull();
});
