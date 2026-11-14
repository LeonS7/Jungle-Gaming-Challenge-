<!-- Esta página executa cenários guiados contra a API real, sem simular efeitos financeiros no navegador. Assinatura: Leonardo de Souza da Luz -->
<script setup lang="ts">
import { ref } from 'vue';
import {
  ApiRequestError,
  wageringApi,
  type WalletView,
  type WagerRequest,
  type WagerSubmissionView,
} from '../../api/wagering-api';

type ScenarioId = 'concurrency' | 'reversal' | 'out-of-order';
interface ScenarioResult {
  readonly title: string;
  readonly wallet: WalletView;
  readonly responses: readonly WagerSubmissionView[];
  readonly explanation: string;
}

const activeScenario = ref<ScenarioId | null>(null);
const result = ref<ScenarioResult | null>(null);
const errorMessage = ref<string | null>(null);
const emit = defineEmits<{ (event: 'wallet-created', wallet: WalletView): void }>();

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function showError(error: unknown): void {
  errorMessage.value = error instanceof ApiRequestError
    ? `${error.message} (HTTP ${error.status}${error.code ? ` · ${error.code}` : ''})`
    : 'Não foi possível executar o cenário. Verifique se a API está disponível.';
}

async function createScenarioWallet(): Promise<WalletView> {
  return wageringApi.createWallet(`cenario-${newId()}`, {
    amount: '100.00',
    currency: 'BRL',
  });
}

function wager(
  wallet: WalletView,
  kind: WagerRequest['kind'],
  amount: string,
  roundId: string,
  externalTransactionId: string,
  referenceExternalTransactionId?: string,
): Promise<WagerSubmissionView> {
  return wageringApi.submitWager({
    providerId: 'laboratorio-guiado',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId,
    gameId: 'cenario-guiado',
    kind,
    money: { amount, currency: wallet.balance.currency },
    ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
  }, newId());
}

async function runScenario(scenario: ScenarioId): Promise<void> {
  const descriptions: Readonly<Record<ScenarioId, string>> = {
    concurrency: 'O cenário cria uma carteira de R$ 100,00 e envia duas BETs de R$ 80,00 ao mesmo tempo. O esperado é uma processada e uma rejeitada por saldo insuficiente.',
    reversal: 'O cenário cria uma BET de R$ 20,00, faz REFUND da BET e depois ROLLBACK do REFUND. O saldo esperado ao final é R$ 80,00.',
    'out-of-order': 'O cenário envia WIN referenciando uma BET ainda inexistente e depois registra a BET. O WIN deve ficar PENDING_REFERENCE até o worker resolver a referência persistida.',
  };
  const accepted = window.confirm(`${descriptions[scenario]} As operações serão gravadas no PostgreSQL local. Executar?`);
  if (!accepted) {
    return;
  }

  activeScenario.value = scenario;
  errorMessage.value = null;
  result.value = null;
  try {
    const wallet = await createScenarioWallet();
    const roundId = `round-${newId()}`;
    let responses: WagerSubmissionView[];
    if (scenario === 'concurrency') {
      responses = await Promise.all([
        wager(wallet, 'BET', '80.00', roundId, `bet-a-${newId()}`),
        wager(wallet, 'BET', '80.00', roundId, `bet-b-${newId()}`),
      ]);
    } else if (scenario === 'reversal') {
      const betExternalId = `bet-${newId()}`;
      const bet = await wager(wallet, 'BET', '20.00', roundId, betExternalId);
      const refundExternalId = `refund-${newId()}`;
      const refund = await wager(wallet, 'REFUND', '20.00', roundId, refundExternalId, betExternalId);
      const rollback = await wager(wallet, 'ROLLBACK', '20.00', roundId, `rollback-${newId()}`, refundExternalId);
      responses = [bet, refund, rollback];
    } else {
      const betExternalId = `bet-atrasada-${newId()}`;
      const pendingWin = await wager(wallet, 'WIN', '20.00', roundId, `win-antes-${newId()}`, betExternalId);
      const bet = await wager(wallet, 'BET', '10.00', roundId, betExternalId);
      responses = [pendingWin, bet];
    }
    const updatedWallet = await wageringApi.getWallet(wallet.id);
    result.value = {
      title: descriptions[scenario],
      wallet: updatedWallet,
      responses,
      explanation: scenario === 'out-of-order'
        ? 'A resolução do WIN pendente depende do worker persistente. Consulte o extrato ou a transação para acompanhar a mudança de estado.'
        : 'Os estados e o saldo exibidos são respostas consultadas na API depois das operações.',
    };
    emit('wallet-created', updatedWallet);
  } catch (error) {
    showError(error);
  } finally {
    activeScenario.value = null;
  }
}

function responseLabel(response: WagerSubmissionView): string {
  return response.failureCode ? `${response.status} · ${response.failureCode}` : response.status;
}
</script>

<template>
  <section class="workspace-card workspace-card-wide guided-scenarios">
    <div class="workspace-card-heading">
      <div><p class="section-kicker">CENÁRIOS GUIADOS</p><h2>Demonstrações com API real</h2></div>
      <span class="workspace-icon" aria-hidden="true">⚗</span>
    </div>
    <p class="workspace-help">Cada execução cria uma carteira nova de R$ 100,00 e grava comandos reais no PostgreSQL. A página mostra apenas o que a API devolve.</p>
    <div class="scenario-grid">
      <article class="scenario-card">
        <h3>Duas BETs simultâneas</h3>
        <p>R$ 80,00 + R$ 80,00 disputam uma carteira de R$ 100,00.</p>
        <span>Esperado: uma processada e uma rejeitada.</span>
        <button class="secondary-button" type="button" :disabled="activeScenario !== null" @click="runScenario('concurrency')">{{ activeScenario === 'concurrency' ? 'Executando…' : 'Executar cenário' }}</button>
      </article>
      <article class="scenario-card">
        <h3>REFUND e ROLLBACK</h3>
        <p>BET de R$ 20,00, estorno e reversão do estorno.</p>
        <span>Esperado: saldo final de R$ 80,00.</span>
        <button class="secondary-button" type="button" :disabled="activeScenario !== null" @click="runScenario('reversal')">{{ activeScenario === 'reversal' ? 'Executando…' : 'Executar cenário' }}</button>
      </article>
      <article class="scenario-card">
        <h3>Fora de ordem</h3>
        <p>WIN chega antes da BET que ele referencia.</p>
        <span>Esperado: WIN pendente até o worker resolver.</span>
        <button class="secondary-button" type="button" :disabled="activeScenario !== null" @click="runScenario('out-of-order')">{{ activeScenario === 'out-of-order' ? 'Executando…' : 'Executar cenário' }}</button>
      </article>
    </div>
    <div v-if="result" class="scenario-result" role="status">
      <strong>Cenário concluído</strong>
      <p>{{ result.title }}</p>
      <p>Carteira: <span class="mono-value">{{ result.wallet.id }}</span> · saldo consultado: <b>{{ result.wallet.balance.amount }} {{ result.wallet.balance.currency }}</b></p>
      <ul><li v-for="response in result.responses" :key="response.transactionId"><span class="mono-value">{{ response.transactionId }}</span> — {{ responseLabel(response) }}</li></ul>
      <p>{{ result.explanation }}</p>
    </div>
    <p v-if="errorMessage" class="workspace-message message-error" role="alert">{{ errorMessage }}</p>
  </section>
</template>
