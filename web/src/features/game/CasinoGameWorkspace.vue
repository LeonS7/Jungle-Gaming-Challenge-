<!-- Esta página oferece a experiência de jogo Fortune Chimp usando somente a API financeira real. Assinatura: Leonardo de Souza da Luz -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  ApiRequestError,
  wageringApi,
  type WalletView,
  type WagerRequest,
  type WagerSubmissionView,
} from '../../api/wagering-api';

interface ActiveBet {
  readonly externalTransactionId: string;
  readonly roundId: string;
  readonly amount: string;
}

const props = defineProps<{ readonly wallet: WalletView | null }>();
const emit = defineEmits<{
  (event: 'wallet-refreshed', wallet: WalletView): void;
  (event: 'open-statement'): void;
  (event: 'last-request-changed', request: { payload: WagerRequest; key: string } | null): void;
}>();

const providerId = 'fortune-chimp';
const gameId = 'fortune-chimp';
const betAmount = ref('10.00');
const prizeAmount = ref('20.00');
const activeBet = ref<ActiveBet | null>(null);
const busy = ref(false);
const result = ref<WagerSubmissionView | null>(null);
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

const canBet = computed(() => props.wallet !== null && !busy.value && activeBet.value === null);
const canResolve = computed(() => activeBet.value !== null && !busy.value);

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function showError(error: unknown): void {
  errorMessage.value = error instanceof ApiRequestError
    ? `${error.message} (HTTP ${error.status}${error.code ? ` · ${error.code}` : ''})`
    : 'Não foi possível concluir a jogada. Verifique se a API está disponível.';
}

function validPositiveMoney(value: string): boolean {
  return /^\d{1,28}\.\d{2}$/.test(value) && !/^0+\.00$/.test(value);
}

async function refreshWallet(): Promise<void> {
  if (!props.wallet) {
    return;
  }
  emit('wallet-refreshed', await wageringApi.getWallet(props.wallet.id));
}

async function submit(payload: WagerRequest, label: string): Promise<WagerSubmissionView | null> {
  busy.value = true;
  errorMessage.value = null;
  successMessage.value = null;
  try {
    const key = newId();
    const submission = await wageringApi.submitWager(payload, key);
    emit('last-request-changed', { payload, key });
    result.value = submission;
    await refreshWallet();
    successMessage.value = `${label}: ${submission.status}. O resultado foi recebido da API.`;
    return submission;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    busy.value = false;
  }
}

async function placeBet(): Promise<void> {
  if (!props.wallet || !validPositiveMoney(betAmount.value)) {
    errorMessage.value = 'Informe uma aposta positiva em formato decimal, por exemplo 10.00.';
    return;
  }
  const accepted = window.confirm(
    `Enviar BET de ${betAmount.value} ${props.wallet.balance.currency} para a API?`,
  );
  if (!accepted) {
    return;
  }
  const candidate: ActiveBet = {
    externalTransactionId: `fortune-bet-${newId()}`,
    roundId: `fortune-round-${newId()}`,
    amount: betAmount.value,
  };
  const submission = await submit({
    providerId,
    externalTransactionId: candidate.externalTransactionId,
    playerId: props.wallet.playerId,
    walletId: props.wallet.id,
    roundId: candidate.roundId,
    gameId,
    kind: 'BET',
    money: { amount: candidate.amount, currency: props.wallet.balance.currency },
  }, 'Aposta enviada');
  if (submission?.status === 'PROCESSED') {
    activeBet.value = candidate;
    prizeAmount.value = candidate.amount === '10.00' ? '20.00' : prizeAmount.value;
    successMessage.value = 'Aposta processada. Escolha agora o resultado da rodada.';
  }
}

async function resolveBet(kind: 'WIN' | 'LOSS'): Promise<void> {
  const wallet = props.wallet;
  const bet = activeBet.value;
  if (!wallet || !bet) {
    return;
  }
  const amount = kind === 'WIN' ? prizeAmount.value : bet.amount;
  if (!validPositiveMoney(amount)) {
    errorMessage.value = 'Informe um prêmio positivo em formato decimal, por exemplo 20.00.';
    return;
  }
  const accepted = window.confirm(
    kind === 'WIN'
      ? `Enviar WIN de ${amount} ${wallet.balance.currency} como resultado desta rodada?`
      : `Enviar LOSS de ${amount} ${wallet.balance.currency}. LOSS não deve criar movimento financeiro adicional.`,
  );
  if (!accepted) {
    return;
  }
  const submission = await submit({
    providerId,
    externalTransactionId: `fortune-${kind.toLowerCase()}-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: bet.roundId,
    gameId,
    kind,
    money: { amount, currency: wallet.balance.currency },
    ...(kind === 'WIN' ? { referenceExternalTransactionId: bet.externalTransactionId } : {}),
  }, kind === 'WIN' ? 'Prêmio enviado' : 'Perda enviada');
  if (submission?.status === 'PROCESSED') {
    activeBet.value = null;
  }
}

watch(() => props.wallet?.id, () => {
  activeBet.value = null;
  result.value = null;
  errorMessage.value = null;
  successMessage.value = null;
});
</script>

<template>
  <section class="casino-game">
    <div v-if="!wallet" class="casino-empty">
      <span class="casino-empty-icon" aria-hidden="true">♧</span>
      <h2>Escolha uma carteira para entrar na mesa</h2>
      <p>Crie ou selecione uma carteira acima. O saldo continuará sendo consultado pela API.</p>
    </div>

    <template v-else>
      <header class="casino-player-bar">
        <div><span>JOGADOR</span><strong>{{ wallet.playerId }}</strong></div>
        <div><span>CARTEIRA</span><strong>{{ wallet.balance.currency }}</strong></div>
        <div class="casino-balance"><span>SALDO DISPONÍVEL</span><strong>{{ wallet.balance.amount }} {{ wallet.balance.currency }}</strong></div>
      </header>

      <div class="fortune-stage" :class="{ 'fortune-stage-active': activeBet }">
        <div class="fortune-lights" aria-hidden="true">✦ ✦ ✦</div>
        <p>FORTUNE CHIMP</p>
        <div class="fortune-icons" aria-hidden="true"><span>🐵</span><span>🎰</span><span>🍀</span></div>
        <h2>{{ activeBet ? 'Rodada em andamento' : 'A mesa está aberta' }}</h2>
        <span>{{ activeBet ? `Aposta registrada: ${activeBet.amount} ${wallet.balance.currency}` : 'Faça sua aposta e aguarde o resultado.' }}</span>
      </div>

      <div class="casino-controls">
        <section class="casino-control-card">
          <p class="section-kicker">VALOR DA APOSTA</p>
          <label class="casino-money-input">
            <span>{{ wallet.balance.currency }}</span>
            <input v-model="betAmount" :disabled="!canBet" inputmode="decimal" autocomplete="off" aria-label="Valor da aposta" />
          </label>
          <div class="casino-quick-values" aria-label="Valores rápidos">
            <button v-for="value in ['5.00', '10.00', '20.00', '80.00']" :key="value" type="button" :disabled="!canBet" @click="betAmount = value">{{ value }}</button>
          </div>
          <button class="casino-play-button" type="button" :disabled="!canBet" @click="placeBet">
            {{ busy ? 'PROCESSANDO' : activeBet ? 'AGUARDE O RESULTADO' : 'APOSTAR' }}
          </button>
        </section>

        <section class="casino-control-card casino-result-card">
          <p class="section-kicker">RESULTADO DA RODADA</p>
          <p class="casino-result-help">Ganhar e perder só ficam disponíveis depois que a BET for processada pela API.</p>
          <label v-if="activeBet" class="casino-prize-input">Prêmio (WIN)
            <input v-model="prizeAmount" :disabled="!canResolve" inputmode="decimal" autocomplete="off" />
          </label>
          <div class="casino-result-actions">
            <button class="casino-win-button" type="button" :disabled="!canResolve" @click="resolveBet('WIN')">GANHAR</button>
            <button class="casino-loss-button" type="button" :disabled="!canResolve" @click="resolveBet('LOSS')">PERDER</button>
          </div>
        </section>
      </div>

      <div v-if="result" class="casino-api-result" role="status">
        <strong>{{ result.status }}</strong>
        <span v-if="result.balance">Saldo devolvido pela API: {{ result.balance.amount }} {{ result.balance.currency }}</span>
        <span v-else-if="result.failureCode">Resultado: {{ result.failureCode }}</span>
        <button type="button" class="secondary-button compact-button" @click="emit('open-statement')">Ver no extrato</button>
      </div>
      <p v-if="errorMessage" class="workspace-message message-error" role="alert">{{ errorMessage }}</p>
      <p v-if="successMessage" class="workspace-message message-success" role="status">{{ successMessage }}</p>
    </template>
  </section>
</template>
