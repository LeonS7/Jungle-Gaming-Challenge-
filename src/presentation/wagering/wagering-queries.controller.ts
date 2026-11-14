/**
 * Esta página expõe consultas HTTP de transações por ID interno ou provedor.
 * Assinatura: Leonardo de Souza da Luz
 */
import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PersistenceUnavailableError } from '../../application/shared/persistence-unavailable.error.js';
import {
  GetWagerTransaction,
  WagerTransactionNotFoundError,
} from '../../application/wagering/get-wager-transaction.js';

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function httpError(status: number, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

function mapReadError(
  error: unknown,
  context: Readonly<Record<string, string>>,
): HttpException {
  if (error instanceof WagerTransactionNotFoundError) {
    return new NotFoundException({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'TRANSACTION_NOT_FOUND',
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
    event: 'wager.http.transaction_query_failed',
    ...context,
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    errorName: error instanceof Error ? error.name : 'Erro desconhecido',
  }), WageringQueriesController.name);
  return httpError(
    HttpStatus.INTERNAL_SERVER_ERROR,
    'INTERNAL_ERROR',
    'Ocorreu uma falha interna ao consultar a transação.',
  );
}

@Controller()
export class WageringQueriesController {
  constructor(private readonly getWagerTransaction: GetWagerTransaction) {}

  @Get('wagering/transactions/:transactionId')
  async findById(@Param('transactionId') transactionId: string) {
    if (!UUID_PATTERN.test(transactionId)) {
      throw httpError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST',
        'transactionId deve ser um UUID válido.',
      );
    }

    try {
      return await this.getWagerTransaction.byId(transactionId);
    } catch (error) {
      throw mapReadError(error, {
        correlationId: transactionId,
        transactionId,
      });
    }
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    try {
      return await this.getWagerTransaction.byProviderExternalId(
        providerId,
        externalTransactionId,
      );
    } catch (error) {
      throw mapReadError(error, {
        correlationId: externalTransactionId,
        providerId,
      });
    }
  }
}
