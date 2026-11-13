/**
 * Esta página mapeia a carteira persistida para as colunas do PostgreSQL.
 * Assinatura: Leonardo de Souza da Luz
 */
import { DecimalType } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({ name: 'wallets_player_currency_uq', properties: ['playerId', 'currency'] })
@Unique({ name: 'wallets_id_currency_uq', properties: ['id', 'currency'] })
@Unique({
  name: 'wallets_id_player_currency_uq',
  properties: ['id', 'playerId', 'currency'],
})
export class WalletRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'text' })
  playerId!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  @Property({ type: DecimalType, precision: 30, scale: 2 })
  balance!: string;

  @Property({ type: 'integer', default: 1 })
  version!: number;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
