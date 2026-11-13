/**
 * Esta página abre carteiras e monta a transação e o crédito de abertura.
 * Assinatura: Leonardo de Souza da Luz
 */
import { createHash, randomUUID } from 'node:crypto';
import { Money } from '../../domain/money/money.js';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from '../outbox/integration-events.js';
import type {
  OpenWalletPersistencePort,
  WalletOpeningRecords,
} from './open-wallet.port.js';

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: Money;
}

export interface OpenWalletResult {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
}

export class OpenWallet {
  constructor(private readonly persistence: OpenWalletPersistencePort) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
    });
    const opening = this.createOpeningRecords(wallet);

    await this.persistence.create(wallet, opening);

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance,
      version: wallet.version,
    };
  }

  private createOpeningRecords(
    wallet: Wallet,
  ): WalletOpeningRecords | undefined {
    if (!wallet.balance.isPositive()) {
      return undefined;
    }

    const transactionId = randomUUID();
    const createdAt = wallet.createdAt;
    const money = wallet.balance;
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          initialBalance: money.toJSON(),
          playerId: wallet.playerId,
          walletId: wallet.id,
        }),
        'utf8',
      )
      .digest('hex');
    const transaction = WagerTransaction.createOpening({
      id: transactionId,
      providerId: 'internal',
      externalTransactionId: transactionId,
      idempotencyKey: transactionId,
      payloadHash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'wallet-opening',
      gameId: 'internal',
      money,
      createdAt,
    });
    transaction.markProcessed(undefined, createdAt);

    const ledgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore: Money.zero(money.currency),
      balanceAfter: wallet.balance,
      createdAt,
    });

    const transactionProcessed = WagerTransactionProcessed.create({
      eventId: randomUUID(),
      aggregateId: transaction.id,
      correlationId: transaction.id,
      occurredAt: createdAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: wallet.balance.toJSON(),
      },
    });
    const walletBalanceChanged = WalletBalanceChanged.create({
      eventId: randomUUID(),
      aggregateId: wallet.id,
      correlationId: transaction.id,
      occurredAt: createdAt,
      data: {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: ledgerEntry.direction,
        money: ledgerEntry.money.toJSON(),
        balanceBefore: ledgerEntry.balanceBefore.toJSON(),
        balanceAfter: ledgerEntry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });

    return {
      transaction,
      ledgerEntry,
      outboxMessages: [
        {
          transactionId: transaction.id,
          sequenceNumber: 1,
          event: transactionProcessed.toJSON(),
        },
        {
          transactionId: transaction.id,
          sequenceNumber: 2,
          event: walletBalanceChanged.toJSON(),
        },
      ],
    };
  }
}
