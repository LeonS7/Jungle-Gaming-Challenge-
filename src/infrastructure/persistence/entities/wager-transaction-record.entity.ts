/**
 * Esta página mapeia as transações de wagering e suas chaves de unicidade.
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

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'wager_transactions_idempotency_key_uq',
  properties: ['idempotencyKey'],
})
@Unique({
  name: 'wager_transactions_provider_external_uq',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  name: 'wager_transactions_id_wallet_uq',
  properties: ['id', 'walletId'],
})
@Unique({
  name: 'wager_transactions_reference_scope_uq',
  properties: [
    'id',
    'providerId',
    'externalTransactionId',
    'playerId',
    'walletId',
    'roundId',
    'currency',
  ],
})
@Index({
  name: 'wager_transactions_wallet_created_idx',
  properties: ['walletId', 'createdAt', 'id'],
})
export class WagerTransactionRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'text' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'text' })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', type: 'text' })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', type: 'text' })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'text' })
  playerId!: string;

  @Property({ fieldName: 'currency', type: 'char', length: 3 })
  currency!: string;

  @Property({ fieldName: 'round_id', type: 'text' })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'text' })
  gameId!: string;

  @Property({ type: 'varchar', length: 16 })
  kind!: string;

  @Property({ type: DecimalType, precision: 30, scale: 2 })
  amount!: string;

  @Property({
    fieldName: 'reference_external_transaction_id',
    type: 'text',
    nullable: true,
  })
  referenceExternalTransactionId!: string | null;

  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId!: string | null;

  @Property({ type: 'varchar', length: 24 })
  status!: string;

  @Property({ fieldName: 'failure_code', type: 'text', nullable: true })
  failureCode!: string | null;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @Property({ fieldName: 'result_balance', type: DecimalType, precision: 30, scale: 2, nullable: true })
  resultBalance!: string | null;

  @Property({ fieldName: 'result_currency', type: 'char', length: 3, nullable: true })
  resultCurrency!: string | null;
}
