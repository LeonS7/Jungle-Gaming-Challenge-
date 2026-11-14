/**
 * Esta página lista o histórico persistido de wagering com cursor estável.
 * Assinatura: Leonardo de Souza da Luz
 */
import type {
  WagerTransactionPosition,
  WagerTransactionReadModel,
  WagerReadPort,
} from '../wagering/wager-read.port.js';
import type { WalletReadPort } from './wallet-read.port.js';
import { WalletNotFoundError } from './get-wallet.js';

const WALLET_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CURSOR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

interface WalletTransactionsCursor {
  readonly version: 1;
  readonly resource: 'wallet-transactions';
  readonly walletId: string;
  readonly createdAt: string;
  readonly transactionId: string;
}

export class InvalidWalletTransactionsCursorError extends Error {
  constructor() {
    super('O cursor do histórico é inválido ou pertence a outra carteira.');
    this.name = 'InvalidWalletTransactionsCursorError';
  }
}

export interface WalletTransactionsPage {
  readonly items: readonly WagerTransactionReadModel[];
  readonly nextCursor: string | null;
}

function decodeCursor(cursor: string, walletId: string): WagerTransactionPosition {
  try {
    if (cursor.length > 1_024) {
      throw new InvalidWalletTransactionsCursorError();
    }

    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      throw new InvalidWalletTransactionsCursorError();
    }

    const value = JSON.parse(decoded) as Partial<WalletTransactionsCursor>;
    if (
      value.version !== 1 ||
      value.resource !== 'wallet-transactions' ||
      value.walletId !== walletId ||
      typeof value.createdAt !== 'string' ||
      !CURSOR_DATE_PATTERN.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.transactionId !== 'string' ||
      !WALLET_ID_PATTERN.test(value.transactionId)
    ) {
      throw new InvalidWalletTransactionsCursorError();
    }

    return { createdAt: value.createdAt, transactionId: value.transactionId };
  } catch (error) {
    if (error instanceof InvalidWalletTransactionsCursorError) {
      throw error;
    }
    throw new InvalidWalletTransactionsCursorError();
  }
}

function encodeCursor(walletId: string, position: WagerTransactionPosition): string {
  const value: WalletTransactionsCursor = {
    version: 1,
    resource: 'wallet-transactions',
    walletId,
    createdAt: position.createdAt,
    transactionId: position.transactionId,
  };
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export class GetWalletTransactions {
  constructor(
    private readonly walletReadPort: WalletReadPort,
    private readonly wagerReadPort: WagerReadPort,
  ) {}

  async execute(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<WalletTransactionsPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('O limite do histórico deve estar entre 1 e 100.');
    }

    if (!(await this.walletReadPort.findWalletById(walletId))) {
      throw new WalletNotFoundError();
    }

    const before = cursor === undefined ? undefined : decodeCursor(cursor, walletId);
    const slice = await this.wagerReadPort.findByWalletId(walletId, before, limit);
    return {
      items: slice.rows,
      nextCursor:
        slice.hasMore && slice.lastPosition
          ? encodeCursor(walletId, slice.lastPosition)
          : null,
    };
  }
}
