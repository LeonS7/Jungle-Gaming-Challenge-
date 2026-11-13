/**
 * Esta página expõe BET, WIN e LOSS por HTTP e traduz erros em respostas estáveis.
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
import { InvalidWagerTransactionError } from '../../domain/wagering/wager-transaction.js';
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

  Logger.error(
    'Falha interna ao submeter uma transação de wagering.',
    error instanceof Error ? error.stack : undefined,
    WageringController.name,
  );
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
  ): Promise<{
    transactionId: string;
    status: string;
    balance: { amount: string; currency: string };
    idempotentReplay: boolean;
    failureCode?: string;
  }> {
    try {
      const command = parseSubmitWagerRequest(body, idempotencyKey);
      const result = await this.processWager.execute(command);
      return {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance.toJSON(),
        idempotentReplay: result.idempotentReplay,
        ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      };
    } catch (error) {
      throw mapWageringError(error);
    }
  }
}
