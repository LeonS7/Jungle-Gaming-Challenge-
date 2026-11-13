/**
 * Esta página expõe endpoints de liveness e readiness sem autenticação.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  getLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  getReadiness(): Promise<{ status: 'ok'; dependencies: { postgres: 'ok'; sqs: 'ok' } }> {
    return this.healthService.checkReadiness();
  }
}
