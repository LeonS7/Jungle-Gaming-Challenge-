<!-- Esta página usa o histórico persistido para preparar reversões e consultar referências pendentes pela API. Assinatura: Leonardo de Souza da Luz -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  ApiRequestError,
  wageringApi,
  type WalletView,
  type WagerTransactionView,
} from '../../api/wagering-api';
import {
  canReverseTransaction,
  clearRetryableRequest,
  createReversalPayload,
  loadRetryableRequest,
  saveRetryableRequest,
  type RetryableWagerRequest,
  type ReversalKind,
} from './laboratory-operations';

const REQUEST_TIMEOUT_MILLISECONDS = 8_000;
const PAGE_SIZE = 20;
const props = defineProps<{ readonly wallet: WalletView | null }>();
const emit = defineEmits<{ (event: 'wallet-refreshed', wallet: WalletView): void }>();

const kind = ref<ReversalKind>('REFUND');
const selectedTransactionId = ref('');
const pendingTransactionId = ref('');
const transactions = ref<WagerTransactionView[]>([]);
const nextCursor = ref<string | null>(null);
const retryRequest = ref<RetryableWagerRequest | null>(null);
const transactionResult = ref<WagerTransactionView | null>(null);
const responseResult = ref<{ status: string; failureCode?: string; transactionId: string } | null>(null);
const loading = ref(false);
const busy = ref(false);
const errorMessage = ref<string | null>(null);
const noticeMessage = ref<string | null>(null);
let historySequence = 0;

const eligibleTransactions = computed(() => transactions.value.filter((transaction) =>
  canReverseTransaction(transaction, kind.value),
));
const pendingTransactions = computed(() => transactions.value.filter((transaction) =>
  transaction.status === 'PENDING_REFERENCE' || transaction.status === 'PENDING',
));
const selectedTransaction = computed(() => eligibleTransactions.value.find(
  (transaction) => transaction.transactionId === selectedTransactionId.value,
));

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return `${error.message} (HTTP ${error.status}${error.code ? ` · ${error.code}` : ''})`;
  }
  return 'A conexão foi interrompida ou excedeu oito segundos. O resultado é incerto; a solicitação original e a chave foram preservadas para retry idêntico.';
}

function useBrowserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function replaceTransaction(updated: WagerTransactionView): void {
  const index = transactions.value.findIndex((item) => item.transactionId === updated.transactionId);
  if (index >= 0) {
    transactions.value[index] = updated;
  }
  transactionResult.value = updated;
  responseResult.value = {
    status: updated.status,
    ...(updated.failureCode ? { failureCode: updated.failureCode } : {}),
    transactionId: updated.transactionId,
  };
}

async function loadHistory(cursor?: string): Promise<void> {
  const walletId = props.wallet?.id;
  if (!walletId) {
    transactions.value = [];
    nextCursor.value = null;
    return;
  }
  const sequence = ++historySequence;
  loading.value = true;
  errorMessage.value = null;
  try {
    const page = await wageringApi.getWalletTransactions(walletId, cursor, PAGE_SIZE);
    if (sequence !== historySequence || props.wallet?.id !== walletId) return;
    transactions.value = cursor ? [...transactions.value, ...page.items] : [...page.items];
    nextCursor.value = page.nextCursor;
    if (!selectedTransactionId.value || !eligibleTransactions.value.some((item) => item.transactionId === selectedTransactionId.value)) {
      selectedTransactionId.value = eligibleTransactions.value[0]?.transactionId ?? '';
    }
    if (!pendingTransactions.value.some((item) => item.transactionId === pendingTransactionId.value)) {
      pendingTransactionId.value = pendingTransactions.value[0]?.transactionId ?? '';
    }
  } catch (error) {
    if (sequence === historySequence) errorMessage.value = describeError(error);
  } finally {
    if (sequence === historySequence) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (!nextCursor.value || loading.value) return;
  await loadHistory(nextCursor.value);
}

async function refreshWalletAndHistory(): Promise<void> {
  if (!props.wallet) return;
  const wallet = await wageringApi.getWallet(props.wallet.id);
  emit('wallet-refreshed', wallet);
  await loadHistory();
}

async function sendRequest(request: RetryableWagerRequest): Promise<void> {
  busy.value = true;
  errorMessage.value = null;
  noticeMessage.value = null;
  responseResult.value = null;
  transactionResult.value = null;
  retryRequest.value = request;
  const storage = useBrowserStorage();
  if (!storage) {
    errorMessage.value = 'O navegador bloqueou o armazenamento local; a operação não foi enviada para que o retry possa preservar a chave.';
    busy.value = false;
    return;
  }
  try {
    saveRetryableRequest(storage, request);
  } catch {
    retryRequest.value = null;
    errorMessage.value = 'Não foi possível guardar a solicitação original no navegador; a operação não foi enviada.';
    busy.value = false;
    return;
  }
  try {
    const response = await wageringApi.submitWager(
      request.payload,
      request.key,
      AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    );
    responseResult.value = {
      transactionId: response.transactionId,
      status: response.status,
      ...(response.failureCode ? { failureCode: response.failureCode } : {}),
    };
    retryRequest.value = null;
    try {
      clearRetryableRequest(storage);
    } catch {
      noticeMessage.value = 'A resposta foi recebida, mas o navegador não conseguiu limpar a cópia local. Um retry posterior continuará protegido pela chave persistida no backend.';
    }
    try {
      replaceTransaction(await wageringApi.getTransaction(response.transactionId));
    } catch {
      // A resposta da operação continua disponível mesmo se a consulta complementar falhar.
    }
  } catch (error) {
    errorMessage.value = describeError(error);
    retryRequest.value = request;
    busy.value = false;
    return;
  }
  try {
    await refreshWalletAndHistory();
  } catch {
    noticeMessage.value = 'A API respondeu pela operação, mas não foi possível atualizar carteira e histórico. Atualize essas consultas manualmente.';
  }
  if (!noticeMessage.value) {
    noticeMessage.value = 'A API respondeu. Estado e eventual motivo de rejeição são os valores retornados pelo backend.';
  }
  busy.value = false;
}

async function submitReversal(): Promise<void> {
  const source = selectedTransaction.value;
  if (!source) {
    errorMessage.value = 'Selecione uma transação processada disponível no histórico carregado.';
    return;
  }
  const payload = createReversalPayload(source, kind.value, `laboratorio-${kind.value.toLowerCase()}-${newId()}`);
  const accepted = window.confirm(
    `Enviar ${payload.kind} de ${payload.money.amount} ${payload.money.currency}, usando como referência ${source.externalTransactionId}? O backend validará a reversão e esta tentativa ficará registrada.`,
  );
  if (!accepted) return;
  await sendRequest({ payload, key: newId() });
}

async function retryOriginalRequest(): Promise<void> {
  const request = retryRequest.value;
  if (!request) return;
  const accepted = window.confirm(
    `Reenviar exatamente o mesmo payload com a chave ${request.key}? A API decidirá se já existe resultado persistido.`,
  );
  if (!accepted) return;
  await sendRequest(request);
}

async function refreshPendingTransaction(): Promise<void> {
  if (!pendingTransactionId.value) return;
  busy.value = true;
  errorMessage.value = null;
  noticeMessage.value = null;
  try {
    replaceTransaction(await wageringApi.getTransaction(pendingTransactionId.value));
    noticeMessage.value = 'Consulta manual concluída; o estado exibido foi lido novamente da API.';
    await loadHistory();
  } catch (error) {
    errorMessage.value = describeError(error);
  } finally {
    busy.value = false;
  }
}

function formatTransaction(transaction: WagerTransactionView): string {
  return `${transaction.kind} · ${transaction.money.amount} ${transaction.money.currency} · ${transaction.status} · ${transaction.externalTransactionId}`;
}

onMounted(() => {
  const storage = useBrowserStorage();
  retryRequest.value = storage ? loadRetryableRequest(storage) : null;
});

watch(() => props.wallet?.id, () => {
  transactions.value = [];
  nextCursor.value = null;
  selectedTransactionId.value = '';
  pendingTransactionId.value = '';
  transactionResult.value = null;
  responseResult.value = null;
  void loadHistory();
}, { immediate: true });
</script>

<template>
  <section class="workspace-grid transaction-lab">
    <article class="workspace-card workspace-card-wide">
      <div class="workspace-card-heading">
        <div><p class="section-kicker">REVERSÕES COM REFERÊNCIA REAL</p><h2>REFUND e ROLLBACK</h2></div>
        <span class="workspace-icon" aria-hidden="true">↶</span>
      </div>
      <p class="workspace-help">Selecione uma transação carregada do histórico paginado. O identificador externo, a rodada, o provedor, a carteira, o valor textual e a moeda são copiados da resposta da API; o backend valida e executa a reversão.</p>

      <div v-if="!props.wallet" class="notice-box">Selecione uma carteira na área Jogo para consultar o histórico.</div>
      <template v-else>
        <div class="history-controls">
          <div class="lookup-tabs" role="group" aria-label="Tipo de reversão">
            <button type="button" :class="{ 'lookup-active': kind === 'REFUND' }" :aria-pressed="kind === 'REFUND'" @click="kind = 'REFUND'">REFUND de BET</button>
            <button type="button" :class="{ 'lookup-active': kind === 'ROLLBACK' }" :aria-pressed="kind === 'ROLLBACK'" @click="kind = 'ROLLBACK'">ROLLBACK</button>
          </div>
          <span class="history-count">{{ transactions.length }} transações carregadas</span>
        </div>
        <form class="form-stack" @submit.prevent="submitReversal">
          <label>Transação processada no histórico
            <select v-model="selectedTransactionId" required :disabled="loading || eligibleTransactions.length === 0">
              <option value="" disabled>{{ loading ? 'Carregando histórico…' : 'Selecione uma transação' }}</option>
              <option v-for="transaction in eligibleTransactions" :key="transaction.transactionId" :value="transaction.transactionId">{{ formatTransaction(transaction) }}</option>
            </select>
          </label>
          <p class="field-hint">{{ kind === 'REFUND' ? 'O domínio aceita REFUND somente de BET processada.' : 'O domínio aceita ROLLBACK de BET, WIN ou REFUND processada.' }} O valor permanece idêntico ao registro de origem.</p>
          <div class="button-row">
            <button class="warning-button" type="submit" :disabled="busy || !selectedTransaction">{{ busy ? 'Enviando…' : `Confirmar ${kind}` }}</button>
            <button v-if="nextCursor" class="secondary-button" type="button" :disabled="loading || busy" @click="loadMore">{{ loading ? 'Carregando…' : 'Carregar transações anteriores' }}</button>
            <button class="secondary-button" type="button" :disabled="loading || busy" @click="loadHistory()">{{ loading ? 'Consultando…' : 'Atualizar histórico' }}</button>
          </div>
        </form>
      </template>
    </article>

    <article class="workspace-card workspace-card-wide">
      <div class="workspace-card-heading">
        <div><p class="section-kicker">REFERÊNCIAS FORA DE ORDEM</p><h2>Consultar transação pendente</h2></div>
        <span class="workspace-icon" aria-hidden="true">⌕</span>
      </div>
      <p class="workspace-help">A consulta é manual e não cria outra operação. Ela lê novamente uma referência pendente pelo ID interno retornado pela API.</p>
      <div v-if="!pendingTransactions.length" class="empty-workspace">Nenhuma referência pendente nas páginas carregadas.</div>
      <div v-else class="form-stack">
        <label>Referência pendente
          <select v-model="pendingTransactionId" :disabled="busy">
            <option v-for="transaction in pendingTransactions" :key="transaction.transactionId" :value="transaction.transactionId">{{ formatTransaction(transaction) }}</option>
          </select>
        </label>
        <button class="secondary-button" type="button" :disabled="busy || !pendingTransactionId" @click="refreshPendingTransaction">{{ busy ? 'Consultando…' : 'Consultar estado agora' }}</button>
      </div>
      <div v-if="transactionResult" class="transaction-result" aria-live="polite">
        <div class="result-heading"><strong>{{ transactionResult.kind }} · {{ transactionResult.status }}</strong><span>{{ transactionResult.money.amount }} {{ transactionResult.money.currency }}</span></div>
        <dl><div><dt>Transação interna</dt><dd class="mono-value">{{ transactionResult.transactionId }}</dd></div><div><dt>ID externo de referência</dt><dd>{{ transactionResult.referenceExternalTransactionId || 'Não informado' }}</dd></div><div><dt>Motivo</dt><dd>{{ transactionResult.failureCode || 'Sem falha reportada' }}</dd></div></dl>
      </div>
    </article>

    <article v-if="retryRequest" class="workspace-card workspace-card-wide retry-card">
      <div class="workspace-card-heading">
        <div><p class="section-kicker">TENTATIVA DE RESULTADO INCERTO</p><h2>Retry idêntico</h2></div>
        <span class="workspace-icon" aria-hidden="true">↻</span>
      </div>
      <p class="workspace-help">O navegador preservou o payload original e a chave de idempotência. O retry reenviará os mesmos dados; o PostgreSQL decide se há um resultado anterior.</p>
      <div class="idempotency-actions">
        <div><strong>Chave original</strong><span>{{ retryRequest.key }}</span></div>
        <div><strong>Operação</strong><span>{{ retryRequest.payload.kind }} · {{ retryRequest.payload.money.amount }} {{ retryRequest.payload.money.currency }} · {{ retryRequest.payload.externalTransactionId }}</span></div>
        <button class="secondary-button" type="button" :disabled="busy" @click="retryOriginalRequest">{{ busy ? 'Reenviando…' : 'Repetir exatamente' }}</button>
      </div>
    </article>

    <div v-if="responseResult" class="submission-result transaction-lab-result" role="status">
      <strong>{{ responseResult.status }}<span v-if="responseResult.failureCode"> · {{ responseResult.failureCode }}</span></strong>
      <dl><div><dt>ID da transação</dt><dd class="mono-value">{{ responseResult.transactionId }}</dd></div></dl>
    </div>
    <p v-if="errorMessage" class="workspace-message message-error" role="alert">{{ errorMessage }}</p>
    <p v-if="noticeMessage" class="workspace-message message-success" role="status">{{ noticeMessage }}</p>
  </section>
</template>
