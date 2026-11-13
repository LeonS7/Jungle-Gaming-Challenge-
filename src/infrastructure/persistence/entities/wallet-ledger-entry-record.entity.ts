/**
 * Esta página mapeia os lançamentos imutáveis do ledger da carteira.
 * Assinatura: Leonardo de Souza da Luz
 */
import { DecimalType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({
  name: 'wallet_ledger_entries_wallet_transaction_uq',
  properties: ['walletId', 'transactionId'],
})
@Index({
  name: 'wallet_ledger_entries_wallet_created_idx',
  properties: ['walletId', 'createdAt', 'id'],
})
export class WalletLedgerEntryRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'varchar', length: 6 })
  direction!: string;

  @Property({ type: DecimalType, precision: 30, scale: 2 })
  amount!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_before', type: DecimalType, precision: 30, scale: 2 })
  balanceBefore!: string;

  @Property({ fieldName: 'balance_after', type: DecimalType, precision: 30, scale: 2 })
  balanceAfter!: string;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
