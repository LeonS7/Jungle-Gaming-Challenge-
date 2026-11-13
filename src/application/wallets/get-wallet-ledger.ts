/**
 * Esta página consulta o ledger com paginação por cursor estável e opaco.
 * Assinatura: Leonardo de Souza da Luz
 */
import type {
  WalletLedgerPosition,
  WalletLedgerRow,
  WalletReadPort,
} from './wallet-read.port.js';
import { WalletNotFoundError } from './get-wallet.js';

const WALLET_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CURSOR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

interface WalletLedgerCursor {
  readonly version: 1;
  readonly walletId: string;
  readonly createdAt: string;
  readonly id: string;
}

export class InvalidWalletLedgerCursorError extends Error {
  constructor() {
    super('O cursor do ledger é inválido ou pertence a outra carteira.');
    this.name = 'InvalidWalletLedgerCursorError';
  }
}

export interface WalletLedgerPage {
  readonly items: readonly Omit<WalletLedgerRow, 'cursorCreatedAt'>[];
  readonly nextCursor: string | null;
}

function decodeCursor(cursor: string, walletId: string): WalletLedgerPosition {
  try {
    if (cursor.length > 1_024) {
      throw new InvalidWalletLedgerCursorError();
    }

    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      throw new InvalidWalletLedgerCursorError();
    }

    const value = JSON.parse(decoded) as Partial<WalletLedgerCursor>;
    if (
      value.version !== 1 ||
      value.walletId !== walletId ||
      typeof value.createdAt !== 'string' ||
      !CURSOR_DATE_PATTERN.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.id !== 'string' ||
      !WALLET_ID_PATTERN.test(value.id)
    ) {
      throw new InvalidWalletLedgerCursorError();
    }

    return { createdAt: value.createdAt, id: value.id };
  } catch (error) {
    if (error instanceof InvalidWalletLedgerCursorError) {
      throw error;
    }
    throw new InvalidWalletLedgerCursorError();
  }
}

function encodeCursor(walletId: string, row: WalletLedgerRow): string {
  const value: WalletLedgerCursor = {
    version: 1,
    walletId,
    createdAt: row.cursorCreatedAt,
    id: row.id,
  };
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export class GetWalletLedger {
  constructor(private readonly readPort: WalletReadPort) {}

  async execute(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<WalletLedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('O limite do ledger deve estar entre 1 e 100.');
    }

    const wallet = await this.readPort.findWalletById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError();
    }

    const before = cursor === undefined ? undefined : decodeCursor(cursor, walletId);
    const slice = await this.readPort.findLedgerRows(walletId, before, limit);
    const lastRow = slice.rows.at(-1);
    const items = slice.rows.map(({ cursorCreatedAt: _cursorCreatedAt, ...row }) => row);

    return {
      items,
      nextCursor:
        slice.hasMore && lastRow ? encodeCursor(walletId, lastRow) : null,
    };
  }
}
