/**
 * Esta página adapta o cabeçalho HTTP e o corpo ao comando de wagering.
 * Assinatura: Leonardo de Souza da Luz
 */
import { parseWagerCommand } from '../../application/wagering/parse-wager-command.js';
import type { ProcessWagerCommand } from '../../application/wagering/process-wager.js';

export {
  InvalidWagerRequestError,
  UnsupportedWagerKindError,
} from '../../application/wagering/parse-wager-command.js';

export function parseSubmitWagerRequest(
  body: unknown,
  idempotencyKey: unknown,
): ProcessWagerCommand {
  return parseWagerCommand(body, idempotencyKey, 'Idempotency-Key');
}
