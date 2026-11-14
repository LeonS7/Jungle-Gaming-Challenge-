/**
 * Esta página verifica referências pendentes e resolve ou agenda novas tentativas.
 * Assinatura: Leonardo de Souza da Luz
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ProcessWager } from '../../application/wagering/process-wager.js';

const EMPTY_QUEUE_POLL_MILLISECONDS = 1000;
const REFERENCE_BATCH_SIZE = 10;

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(private readonly processWager: ProcessWager) {}

  onModuleInit(): void {
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.processWager.executeDuePendingReferences(
          REFERENCE_BATCH_SIZE,
        );
        for (const outcome of result.outcomes) {
          this.logger.log(JSON.stringify({
            event: 'wager.reference_operation_completed',
            correlationId: outcome.transactionId,
            transactionId: outcome.transactionId,
            providerId: outcome.providerId,
            walletId: outcome.walletId,
            status: outcome.status,
            action: outcome.action,
          }));
        }
        if (result.claimed === 0) {
          await this.wait(EMPTY_QUEUE_POLL_MILLISECONDS);
        } else {
          this.logger.log(JSON.stringify({
            event: 'wager.reference_batch_completed',
            claimed: result.claimed,
            processed: result.processed,
            rejected: result.rejected,
            retried: result.retried,
          }));
        }
      } catch (error) {
        this.logger.error(JSON.stringify({
          event: 'wager.reference_batch_failed',
          errorName: error instanceof Error ? error.name : 'Erro desconhecido',
        }));
        await this.wait(EMPTY_QUEUE_POLL_MILLISECONDS);
      }
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}
