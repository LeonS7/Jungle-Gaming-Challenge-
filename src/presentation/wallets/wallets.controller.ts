/**
 * Esta página expõe a criação de carteiras com respostas HTTP estáveis.
 * Assinatura: Leonardo de Souza da Luz
 */
import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OpenWallet } from '../../application/wallets/open-wallet.js';
import {
  WalletAlreadyExistsError,
  WalletPersistenceInvariantError,
} from '../../application/wallets/open-wallet.port.js';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import { InvalidMoneyError } from '../../domain/money/money.js';
import { InvalidWalletError } from '../../domain/wallet/wallet.js';
import { InvalidOpenWalletRequestError, parseOpenWalletRequest } from './open-wallet.dto.js';

function httpError(status: number, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

function mapWalletError(error: unknown): HttpException {
  if (
    error instanceof InvalidOpenWalletRequestError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWalletError
  ) {
    return httpError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', error.message);
  }
  if (error instanceof WalletAlreadyExistsError) {
    return new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      code: 'WALLET_ALREADY_EXISTS',
      message: error.message,
    });
  }
  if (error instanceof PersistenceUnavailableError) {
    return new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'PERSISTENCE_UNAVAILABLE',
      message: 'O serviço financeiro está temporariamente indisponível.',
    });
  }

  Logger.error(
    'Falha interna ao criar uma carteira.',
    error instanceof Error ? error.stack : undefined,
    WalletsController.name,
  );
  const message =
    error instanceof WalletPersistenceInvariantError
      ? 'Não foi possível persistir um conjunto consistente de abertura.'
      : 'Ocorreu uma falha interna ao criar a carteira.';
  return httpError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', message);
}

@Controller('wallets')
export class WalletsController {
  constructor(private readonly openWallet: OpenWallet) {}

  // Ponto de extensão para anexar autenticação fornecida por um Identity Provider externo.
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
  ): Promise<{
    id: string;
    playerId: string;
    balance: { amount: string; currency: string };
    version: number;
  }> {
    try {
      const command = parseOpenWalletRequest(body);
      const wallet = await this.openWallet.execute(command);
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    } catch (error) {
      throw mapWalletError(error);
    }
  }
}
