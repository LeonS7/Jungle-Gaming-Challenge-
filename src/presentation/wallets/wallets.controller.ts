/**
 * Esta página expõe criação e consultas de carteira com respostas HTTP estáveis.
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
  Get,
  Param,
  NotFoundException,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GetWallet, WalletNotFoundError } from '../../application/wallets/get-wallet.js';
import {
  GetWalletLedger,
  InvalidWalletLedgerCursorError,
} from '../../application/wallets/get-wallet-ledger.js';
import { OpenWallet } from '../../application/wallets/open-wallet.js';
import { ReconcileWallet } from '../../application/wallets/reconcile-wallet.js';
import {
  WalletAlreadyExistsError,
  WalletPersistenceInvariantError,
} from '../../application/wallets/open-wallet.port.js';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import { InvalidMoneyError } from '../../domain/money/money.js';
import { InvalidWalletError } from '../../domain/wallet/wallet.js';
import { InvalidOpenWalletRequestError, parseOpenWalletRequest } from './open-wallet.dto.js';
import {
  InvalidWalletLedgerQueryError,
  parseWalletLedgerQuery,
} from './wallet-ledger-query.dto.js';

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function httpError(status: number, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

function mapWalletError(
  error: unknown,
  context: Readonly<Record<string, string>> = {},
): HttpException {
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

  Logger.error(JSON.stringify({
    event: 'wallet.http.open_failed',
    ...context,
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    errorName: error instanceof Error ? error.name : 'Erro desconhecido',
  }), WalletsController.name);
  const message =
    error instanceof WalletPersistenceInvariantError
      ? 'Não foi possível persistir um conjunto consistente de abertura.'
      : 'Ocorreu uma falha interna ao criar a carteira.';
  return httpError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', message);
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly getWallet: GetWallet,
    private readonly getWalletLedger: GetWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  private requireWalletId(walletId: string): string {
    if (!UUID_PATTERN.test(walletId)) {
      throw httpError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'walletId deve ser um UUID válido.');
    }
    return walletId;
  }

  private mapReadError(
    error: unknown,
    operation: string,
    walletId: string,
  ): HttpException {
    if (error instanceof HttpException) {
      return error;
    }
    if (error instanceof WalletNotFoundError) {
      return new NotFoundException({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'WALLET_NOT_FOUND',
        message: error.message,
      });
    }
    if (
      error instanceof InvalidWalletLedgerCursorError ||
      error instanceof InvalidWalletLedgerQueryError ||
      error instanceof RangeError
    ) {
      return httpError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', error.message);
    }
    if (error instanceof PersistenceUnavailableError) {
      return new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'PERSISTENCE_UNAVAILABLE',
        message: 'O serviço financeiro está temporariamente indisponível.',
      });
    }

    Logger.error(JSON.stringify({
      event: 'wallet.http.query_failed',
      correlationId: walletId,
      walletId,
      operation,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorName: error instanceof Error ? error.name : 'Erro desconhecido',
    }), WalletsController.name);
    return httpError(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'INTERNAL_ERROR',
      'Ocorreu uma falha interna ao consultar a carteira.',
    );
  }

  @Get(':walletId')
  async findById(@Param('walletId') walletId: string) {
    try {
      return await this.getWallet.execute(this.requireWalletId(walletId));
    } catch (error) {
      throw this.mapReadError(error, 'consultar', walletId);
    }
  }

  @Get(':walletId/ledger')
  async findLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    try {
      const query = parseWalletLedgerQuery(cursor, limit);
      return await this.getWalletLedger.execute(
        this.requireWalletId(walletId),
        query.cursor,
        query.limit,
      );
    } catch (error) {
      throw this.mapReadError(error, 'consultar', walletId);
    }
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string) {
    try {
      const result = await this.reconcileWallet.execute(
        this.requireWalletId(walletId),
      );
      if (!result.consistent) {
        Logger.warn(JSON.stringify({
          event: 'wallet.reconciliation.divergence',
          correlationId: result.walletId,
          walletId: result.walletId,
          checkedEntries: result.checkedEntries,
        }), WalletsController.name);
      }
      return result;
    } catch (error) {
      throw this.mapReadError(error, 'reconciliar', walletId);
    }
  }

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
    let context: { readonly correlationId: string; readonly playerId: string } | undefined;
    try {
      const command = parseOpenWalletRequest(body);
      context = {
        correlationId: command.playerId,
        playerId: command.playerId,
      };
      const wallet = await this.openWallet.execute(command);
      Logger.log(JSON.stringify({
        event: 'wallet.http.opened',
        correlationId: wallet.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
      }), WalletsController.name);
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    } catch (error) {
      throw mapWalletError(error, context);
    }
  }
}
