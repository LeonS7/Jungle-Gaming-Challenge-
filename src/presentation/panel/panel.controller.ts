/**
 * Esta página encaminha a raiz HTTP para a interface web configurada.
 * Assinatura: Leonardo de Souza da Luz
 */
import { Controller, Get, Inject, Redirect } from '@nestjs/common';
import type { ApplicationConfig } from '../../config/application-config.js';
import { APPLICATION_CONFIG } from '../../config/config.constants.js';

@Controller()
export class PanelController {
  constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  @Get()
  @Redirect()
  openPanel(): { readonly url: string; readonly statusCode: 302 } {
    return { url: this.config.webPanelUrl, statusCode: 302 };
  }
}
