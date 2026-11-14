<!-- Esta página envia operações e consultas de wagering pela API real. Assinatura: Leonardo de Souza da Luz -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  ApiRequestError,
  wageringApi,
  type WalletView,
  type WagerKind,
  type WagerRequest,
  type WagerSubmissionView,
  type WagerTransactionView,
} from '../../api/wagering-api';

const props = defineProps<{ readonly wallet: WalletView | null }>();
const emit = defineEmits<{ (event: 'wallet-refreshed', wallet: WalletView): void }>();

const providerId = ref('provedor-demo');
const externalTransactionId = ref(newTransactionId());
const playerId = ref('');
const walletId = ref('');
const roundId = ref('rodada-demo-01');
const gameId = ref('jogo-demo');
const kind = ref<WagerKind>('BET');
const amount = ref('10.00');
const referenceExternalTransactionId = ref('');
const idempotencyKey = ref(newTransactionId());
const lastRequest = ref<{ payload: WagerRequest; key: string } | null>(null);
const submission = ref<WagerSubmissionView | null>(null);
const transaction = ref<WagerTransactionView | null>(null);
const lookupMode = ref<'id' | 'provider'>('id');
const lookupTransactionId = ref('');
const lookupProviderId = ref('provedor-demo');
const lookupExternalId = ref('');
const busy = ref(false);
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

const requiresReference = computed(() => kind.value === 'REFUND' || kind.value === 'ROLLBACK');
const canSubmit = computed(() => Boolean(props.wallet) && !busy.value);

function newTransactionId(): string {
  return globalThis.crypto.randomUUID();
}

watch(() => props.wallet, (wallet) => {
  if (wallet) {
    playerId.value = wallet.playerId;
    walletId.value = wallet.id;
  }
}, { immediate: true });

function showError(error: unknown): void {
  errorMessage.value = error instanceof ApiRequestError
    ? `${error.message} (HTTP ${error.status}${error.code ? ` · ${error.code}` : ''})`
    : 'Não foi possível concluir a solicitação. Verifique se a API está disponível.';
}

function makePayload(): WagerRequest | null {
  if (!/^\d{1,28}\.\d{2}$/.test(amount.value) || /^0+\.00$/.test(amount.value)) {
    errorMessage.value = 'Informe um valor positivo com duas casas decimais, por exemplo 10.00.';
    return null;
  }
  if (!playerId.value.trim() || !walletId.value.trim() || !providerId.value.trim() || !externalTransactionId.value.trim() || !roundId.value.trim() || !gameId.value.trim()) {
    errorMessage.value = 'Preencha os campos obrigatórios e selecione uma carteira.';
    return null;
  }
  if (requiresReference.value && !referenceExternalTransactionId.value.trim()) {
    errorMessage.value = 'REFUND e ROLLBACK precisam do identificador externo da transação original.';
    return null;
  }
  return {
    providerId: providerId.value.trim(),
    externalTransactionId: externalTransactionId.value.trim(),
    playerId: playerId.value.trim(),
    walletId: walletId.value.trim(),
    roundId: roundId.value.trim(),
    gameId: gameId.value.trim(),
    kind: kind.value,
    money: { amount: amount.value, currency: props.wallet?.balance.currency ?? '' },
    ...(referenceExternalTransactionId.value.trim()
      ? { referenceExternalTransactionId: referenceExternalTransactionId.value.trim() }
      : {}),
  };
}

async function process(payload: WagerRequest, key: string, confirmation: string): Promise<void> {
  errorMessage.value = null;
  successMessage.value = null;
  const accepted = window.confirm(confirmation);
  if (!accepted) return;

  busy.value = true;
  try {
    submission.value = await wageringApi.submitWager(payload, key);
    lastRequest.value = { payload, key };
    transaction.value = null;
    successMessage.value = submission.value.idempotentReplay
      ? 'A API reconheceu uma repetição idempotente; o saldo não recebeu outro lançamento.'
      : `Resposta recebida: ${submission.value.status}. Consulte os detalhes abaixo.`;
    if (props.wallet) {
      const refreshed = await wageringApi.getWallet(props.wallet.id);
      emit('wallet-refreshed', refreshed);
    }
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}

async function submitCurrent(): Promise<void> {
  const payload = makePayload();
  if (!payload) return;
  await process(
    payload,
    idempotencyKey.value,
    `Enviar ${payload.kind} de ${payload.money.amount} ${payload.money.currency} para a API? A solicitação poderá alterar o saldo da carteira.`,
  );
}

async function replayLast(): Promise<void> {
  if (!lastRequest.value) return;
  await process(
    lastRequest.value.payload,
    lastRequest.value.key,
    'Reenviar exatamente o mesmo conteúdo com a mesma chave de idempotência? A API deve retornar o resultado já persistido.',
  );
}

async function conflictLast(): Promise<void> {
  if (!lastRequest.value) return;
  const alteredPayload: WagerRequest = {
    ...lastRequest.value.payload,
    gameId: `${lastRequest.value.payload.gameId}-alterado`,
  };
  await process(
    alteredPayload,
    lastRequest.value.key,
    'Enviar conteúdo alterado usando a chave já persistida? A API deve responder com conflito de idempotência; nenhum novo lançamento deve ser criado.',
  );
}

function prepareNewOperation(): void {
  externalTransactionId.value = newTransactionId();
  idempotencyKey.value = newTransactionId();
  lastRequest.value = null;
  submission.value = null;
  transaction.value = null;
  errorMessage.value = null;
  successMessage.value = 'Uma nova identidade externa e uma nova chave foram preparadas.';
}

async function lookup(): Promise<void> {
  errorMessage.value = null;
  successMessage.value = null;
  busy.value = true;
  try {
    transaction.value = lookupMode.value === 'id'
      ? await wageringApi.getTransaction(lookupTransactionId.value.trim())
      : await wageringApi.getProviderTransaction(lookupProviderId.value.trim(), lookupExternalId.value.trim());
    successMessage.value = 'Transação encontrada na API.';
  } catch (error) {
    transaction.value = null;
    showError(error);
  } finally {
    busy.value = false;
  }
}

async function openSubmittedTransaction(): Promise<void> {
  if (!submission.value) return;
  lookupMode.value = 'id';
  lookupTransactionId.value = submission.value.transactionId;
  await lookup();
}
</script>

<template>
  <div class="workspace-grid">
    <section class="workspace-card workspace-card-wide">
      <div class="workspace-card-heading">
        <div><p class="section-kicker">SIMULADOR DE JOGADOR</p><h2>Enviar operação de jogo</h2></div>
        <span class="workspace-icon" aria-hidden="true">↗</span>
      </div>
      <p class="workspace-help">A operação é validada e processada pelo backend. BET debita saldo; WIN, LOSS, REFUND e ROLLBACK seguem as regras da API. A tela não calcula nem altera dinheiro localmente.</p>
      <div v-if="!wallet" class="notice-box">Primeiro crie ou selecione uma carteira na seção “Carteiras”.</div>
      <form class="form-stack" @submit.prevent="submitCurrent">
        <div class="form-row form-row-three">
          <label>Provedor<input v-model="providerId" autocomplete="off" required /></label>
          <label>Tipo de operação<select v-model="kind"><option value="BET">Aposta (BET)</option><option value="WIN">Prêmio (WIN)</option><option value="LOSS">Perda (LOSS)</option><option value="REFUND">Estorno (REFUND)</option><option value="ROLLBACK">Reversão (ROLLBACK)</option></select></label>
          <label>Valor decimal<input v-model="amount" inputmode="decimal" autocomplete="off" required /></label>
        </div>
        <div class="form-row form-row-three">
          <label>Identificador externo<input v-model="externalTransactionId" autocomplete="off" required /></label>
          <label>Rodada<input v-model="roundId" autocomplete="off" required /></label>
          <label>Jogo<input v-model="gameId" autocomplete="off" required /></label>
        </div>
        <label v-if="requiresReference">Transação externa original<input v-model="referenceExternalTransactionId" autocomplete="off" required /></label>
        <div class="form-row">
          <label>Chave de idempotência<input v-model="idempotencyKey" autocomplete="off" required /></label>
          <div class="read-only-field"><span>Carteira selecionada</span><strong>{{ wallet ? `${wallet.playerId} · ${wallet.balance.currency}` : 'Nenhuma' }}</strong></div>
        </div>
        <p class="field-hint">O valor permanece como texto decimal com duas casas. A confirmação seguinte envia uma gravação real para o banco local.</p>
        <div class="button-row">
          <button class="primary-button" type="submit" :disabled="!canSubmit">{{ busy ? 'Enviando…' : 'Enviar operação' }}</button>
          <button class="secondary-button" type="button" :disabled="busy" @click="prepareNewOperation">Preparar nova operação</button>
        </div>
      </form>
      <div v-if="lastRequest" class="idempotency-actions">
        <div><strong>Testar idempotência da última solicitação</strong><span>Mesma chave: {{ lastRequest.key }}</span></div>
        <div class="button-row">
          <button class="secondary-button" type="button" :disabled="busy" @click="replayLast">Repetir exatamente</button>
          <button class="warning-button" type="button" :disabled="busy" @click="conflictLast">Repetir com conteúdo alterado</button>
        </div>
      </div>
      <div v-if="submission" class="submission-result" role="status">
        <strong>{{ submission.status }}<span v-if="submission.idempotentReplay"> · repetição idempotente</span></strong>
        <dl><div><dt>Transação interna</dt><dd class="mono-value">{{ submission.transactionId }}</dd></div><div v-if="submission.balance"><dt>Saldo após a decisão</dt><dd>{{ submission.balance.amount }} {{ submission.balance.currency }}</dd></div><div v-if="submission.failureCode"><dt>Motivo da rejeição</dt><dd>{{ submission.failureCode }}</dd></div></dl>
        <button class="secondary-button transaction-open-button" type="button" :disabled="busy" @click="openSubmittedTransaction">Consultar detalhes persistidos</button>
      </div>
    </section>

    <section class="workspace-card workspace-card-wide">
      <div class="workspace-card-heading">
        <div><p class="section-kicker">CONSULTA DE RESULTADO</p><h2>Localizar transação</h2></div>
        <span class="workspace-icon" aria-hidden="true">⌕</span>
      </div>
      <div class="lookup-tabs" role="group" aria-label="Método de consulta">
        <button type="button" :class="{ 'lookup-active': lookupMode === 'id' }" @click="lookupMode = 'id'">Por ID interno</button>
        <button type="button" :class="{ 'lookup-active': lookupMode === 'provider' }" @click="lookupMode = 'provider'">Por provedor</button>
      </div>
      <form class="form-stack" @submit.prevent="lookup">
        <label v-if="lookupMode === 'id'">Identificador interno da transação<input v-model="lookupTransactionId" autocomplete="off" placeholder="UUID retornado pela operação" required /></label>
        <div v-else class="form-row"><label>Provedor<input v-model="lookupProviderId" autocomplete="off" required /></label><label>Identificador externo<input v-model="lookupExternalId" autocomplete="off" required /></label></div>
        <button class="secondary-button" type="submit" :disabled="busy">{{ busy ? 'Consultando…' : 'Consultar transação' }}</button>
      </form>
      <div v-if="transaction" class="transaction-result" aria-live="polite">
        <div class="result-heading"><strong>{{ transaction.kind }} · {{ transaction.status }}</strong><span>{{ transaction.money.amount }} {{ transaction.money.currency }}</span></div>
        <dl><div><dt>ID interno</dt><dd class="mono-value">{{ transaction.transactionId }}</dd></div><div><dt>Provedor e ID externo</dt><dd>{{ transaction.providerId }} · {{ transaction.externalTransactionId }}</dd></div><div><dt>Jogador / rodada</dt><dd>{{ transaction.playerId }} · {{ transaction.roundId }}</dd></div><div><dt>Carteira</dt><dd class="mono-value">{{ transaction.walletId }}</dd></div><div><dt>Referência</dt><dd>{{ transaction.referenceExternalTransactionId || 'Não informada' }}</dd></div><div><dt>Resultado</dt><dd>{{ transaction.failureCode || (transaction.balance ? `${transaction.balance.amount} ${transaction.balance.currency}` : 'Pendente') }}</dd></div></dl>
      </div>
    </section>

    <div v-if="errorMessage" class="workspace-message message-error" role="alert">{{ errorMessage }}</div>
    <div v-if="successMessage" class="workspace-message message-success" role="status">{{ successMessage }}</div>
  </div>
</template>
