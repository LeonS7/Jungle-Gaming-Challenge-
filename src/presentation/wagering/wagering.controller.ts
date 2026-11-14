/**
 * Esta página expõe operações de wagering por HTTP e traduz erros em respostas estáveis.
 * Assinatura: Leonardo de Souza da Luz
 */
import {
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  IdempotencyConflictError,
  IdempotencyReplayUnavailableError,
  ProcessWager,
  ProviderTransactionConflictError,
  WagerCurrencyMismatchError,
  WagerPersistenceInvariantError,
  WagerTransactionNotFinalizedError,
  WagerWalletNotFoundError,
  WagerWalletOwnerMismatchError,
} from '../../application/wagering/process-wager.js';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import { InvalidMoneyError } from '../../domain/money/money.js';
import {
  InvalidWagerTransactionError,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import {
  InvalidWagerRequestError,
  parseSubmitWagerRequest,
  UnsupportedWagerKindError,
} from './submit-wager.dto.js';

function httpError(status: number, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

function mapWageringError(error: unknown): HttpException {
  if (error instanceof InvalidWagerRequestError || error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError) {
    return httpError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', error.message);
  }
  if (error instanceof UnsupportedWagerKindError) {
    return httpError(HttpStatus.NOT_IMPLEMENTED, 'UNSUPPORTED_TRANSACTION_KIND', error.message);
  }
  if (error instanceof WagerCurrencyMismatchError) {
    return httpError(HttpStatus.UNPROCESSABLE_ENTITY, 'CURRENCY_MISMATCH', error.message);
  }
  if (error instanceof IdempotencyConflictError) {
    return new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      code: 'IDEMPOTENCY_CONFLICT',
      message: error.message,
    });
  }
  if (error instanceof ProviderTransactionConflictError) {
    return new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      code: 'PROVIDER_TRANSACTION_CONFLICT',
      message: error.message,
    });
  }
  if (error instanceof WagerWalletNotFoundError || error instanceof WagerWalletOwnerMismatchError) {
    return new NotFoundException({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'WALLET_NOT_FOUND',
      message: 'A carteira solicitada não existe.',
    });
  }
  if (error instanceof PersistenceUnavailableError) {
    return new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'PERSISTENCE_UNAVAILABLE',
      message: 'O serviço financeiro está temporariamente indisponível.',
    });
  }
  if (error instanceof WagerTransactionNotFinalizedError) {
    return httpError(HttpStatus.CONFLICT, 'TRANSACTION_IN_PROGRESS', error.message);
  }

  const message =
    error instanceof IdempotencyReplayUnavailableError ||
    error instanceof WagerPersistenceInvariantError
      ? 'Não foi possível recuperar um resultado financeiro consistente.'
      : 'Ocorreu uma falha interna ao processar a solicitação.';
  return httpError(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', message);
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly processWager: ProcessWager) {}

  // Ponto de extensão para anexar autenticação fornecida por um provedor de identidade externo.
  @Post()
  @HttpCode(HttpStatus.OK)
  async submitWager(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Res({ passthrough: true }) response: { statusCode: number },
  ): Promise<{
    transactionId: string;
    status: string;
    balance?: { amount: string; currency: string };
    idempotentReplay: boolean;
    failureCode?: string;
  }> {
    let context: {
      readonly correlationId: string;
      readonly providerId: string;
      readonly walletId: string;
    } | undefined;
    try {
      const command = parseSubmitWagerRequest(body, idempotencyKey);
      context = {
        correlationId: command.externalTransactionId,
        providerId: command.providerId,
        walletId: command.walletId,
      };
      const result = await this.processWager.execute(command);
      if (result.status === WagerTransactionStatus.PendingReference) {
        response.statusCode = HttpStatus.ACCEPTED;
      }
      Logger.log(JSON.stringify({
        event: 'wager.http.transaction_completed',
        correlationId: result.transactionId,
        transactionId: result.transactionId,
        providerId: command.providerId,
        walletId: command.walletId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      }), WageringController.name);
      return {
        transactionId: result.transactionId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
        ...(result.balance ? { balance: result.balance.toJSON() } : {}),
        ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      };
    } catch (error) {
      const responseError = mapWageringError(error);
      if (responseError.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR) {
        Logger.error(JSON.stringify({
          event: 'wager.http.transaction_failed',
          ...context,
          statusCode: responseError.getStatus(),
          errorName: error instanceof Error ? error.name : 'Erro desconhecido',
        }), WageringController.name);
      }
      throw responseError;
    }
  }
}
