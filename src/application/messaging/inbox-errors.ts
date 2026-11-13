/**
 * Esta página identifica redelivery segura e colisão de conteúdo na inbox.
 * Assinatura: Leonardo de Souza da Luz
 */
export class InboxMessagePayloadConflictError extends Error {
  constructor() {
    super('O mesmo ID de inbox foi recebido com conteúdo diferente.');
    this.name = 'InboxMessagePayloadConflictError';
  }
}
