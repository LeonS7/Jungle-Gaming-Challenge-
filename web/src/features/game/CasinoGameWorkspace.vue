<!-- Esta página oferece a experiência de jogo Fortune Chimp usando somente a API financeira real. Assinatura: Leonardo de Souza da Luz -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  ApiRequestError,
  wageringApi,
  type WalletView,
  type WagerRequest,
  type WagerSubmissionView,
} from '../../api/wagering-api';
import {
  clearRetryableRequest,
  loadRetryableRequest,
  saveRetryableRequest,
  type RetryableWagerRequest,
} from '../laboratory/laboratory-operations';

interface ActiveBet {
  readonly externalTransactionId: string;
  readonly roundId: string;
  readonly amount: string;
}

const props = defineProps<{
  readonly wallet: WalletView | null;
  readonly lastRequest?: RetryableWagerRequest | null;
}>();
const emit = defineEmits<{
  (event: 'wallet-refreshed', wallet: WalletView): void;
  (event: 'open-statement'): void;
  (event: 'open-laboratory'): void;
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
const pendingRetry = ref<RetryableWagerRequest | null>(null);

const canBet = computed(() => props.wallet !== null && !busy.value && activeBet.value === null && pendingRetry.value === null);
const canResolve = computed(() => activeBet.value !== null && !busy.value && pendingRetry.value === null);

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function showError(error: unknown): void {
  if (error instanceof ApiRequestError) {
    const response = `${error.message} (HTTP ${error.status}${error.code ? ` · ${error.code}` : ''}).`;
    errorMessage.value = error.status < 500
      ? `${response} A API respondeu; confira o resultado e use a ferramenta de idempotência no Laboratório se necessário.`
      : `${response} O resultado é incerto; o payload original e a chave foram preservados para retry no Laboratório.`;
    return;
  }
  errorMessage.value = 'A conexão foi interrompida ou excedeu oito segundos. O resultado é incerto; o payload original e a chave foram preservados para retry no Laboratório.';
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

async function restoreProcessedBet(): Promise<void> {
  const request = props.lastRequest;
  const wallet = props.wallet;
  if (!request || request.payload.kind !== 'BET' || !wallet || request.payload.walletId !== wallet.id) {
    return;
  }
  try {
    const transaction = await wageringApi.getProviderTransaction(
      request.payload.providerId,
      request.payload.externalTransactionId,
    );
    if (transaction.status !== 'PROCESSED' || props.wallet?.id !== wallet.id) return;
    activeBet.value = {
      externalTransactionId: transaction.externalTransactionId,
      roundId: transaction.roundId,
      amount: transaction.money.amount,
    };
    if (transaction.money.amount === '10.00') prizeAmount.value = '20.00';
    successMessage.value = 'A BET processada foi recuperada da API. Escolha o resultado desta rodada.';
  } catch {
    // A rodada não é reconstruída quando a API não confirma que a BET foi processada.
  }
}

async function submit(payload: WagerRequest, label: string): Promise<WagerSubmissionView | null> {
  busy.value = true;
  errorMessage.value = null;
  successMessage.value = null;
  const request = { payload, key: newId() };
  let storage: Storage;
  try {
    storage = window.localStorage;
    saveRetryableRequest(storage, request);
  } catch {
    errorMessage.value = 'O navegador bloqueou o armazenamento da solicitação original; a operação não foi enviada.';
    busy.value = false;
    return null;
  }
  pendingRetry.value = request;
  emit('last-request-changed', request);
  let submission: WagerSubmissionView;
  try {
    submission = await wageringApi.submitWager(payload, request.key, AbortSignal.timeout(8_000));
  } catch (error) {
    if (error instanceof ApiRequestError && error.status < 500) {
      try {
        clearRetryableRequest(storage);
      } catch {
        // A resposta HTTP está disponível; o PostgreSQL continua sendo a fonte da verdade.
      }
      pendingRetry.value = null;
    }
    showError(error);
    busy.value = false;
    return null;
  }
  try {
    clearRetryableRequest(storage);
  } catch {
    // Uma cópia local antiga continua protegida pelo registro idempotente do PostgreSQL.
  }
  pendingRetry.value = null;
  result.value = submission;
  try {
    await refreshWallet();
    successMessage.value = `${label}: ${submission.status}. O resultado foi recebido da API.`;
  } catch {
    successMessage.value = `${label}: ${submission.status}. A operação foi confirmada pela API, mas o saldo precisa ser consultado novamente.`;
  }
  busy.value = false;
  return submission;
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
  void restoreProcessedBet();
});

watch(() => props.lastRequest, () => void restoreProcessedBet());

onMounted(() => {
  try {
    pendingRetry.value = loadRetryableRequest(window.localStorage);
  } catch {
    errorMessage.value = 'O navegador bloqueou a leitura de uma tentativa pendente. Abra o Laboratório para verificar e tentar novamente.';
  }
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

      <div v-if="pendingRetry" class="notice-box" role="status">
        Existe uma tentativa com resultado incerto. Novas apostas e resultados ficam bloqueados até reenviar o payload original no Laboratório.
        <button class="secondary-button compact-button" type="button" @click="emit('open-laboratory')">Abrir Laboratório</button>
      </div>

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
      <div v-if="errorMessage" class="workspace-message message-error" role="alert">
        {{ errorMessage }}
        <button v-if="pendingRetry" class="secondary-button compact-button" type="button" @click="emit('open-laboratory')">Abrir Laboratório para retry</button>
      </div>
      <p v-if="successMessage" class="workspace-message message-success" role="status">{{ successMessage }}</p>
    </template>
  </section>
</template>
