<!-- Esta página consulta transações e rodadas persistidas pela API. Assinatura: Leonardo de Souza da Luz -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  ApiRequestError,
  wageringApi,
  type WagerTransactionView,
} from '../../api/wagering-api';
import { formatTimestamp } from '../dashboard/format-timestamp';

const props = defineProps<{
  readonly walletId: string | null;
  readonly active?: boolean;
}>();
const emit = defineEmits<{ (event: 'return-to-game'): void }>();

const PAGE_SIZE = 20;
const transactions = ref<WagerTransactionView[]>([]);
const nextCursor = ref<string | null>(null);
const viewMode = ref<'transactions' | 'rounds'>('transactions');
const loading = ref(false);
const errorMessage = ref<string | null>(null);
let requestSequence = 0;

const roundGroups = computed(() => {
  const groups = new Map<string, {
    readonly roundId: string;
    readonly gameId: string;
    readonly transactions: WagerTransactionView[];
  }>();

  for (const transaction of transactions.value) {
    const groupKey = `${transaction.gameId}\u0000${transaction.roundId}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.transactions.push(transaction);
      continue;
    }
    groups.set(groupKey, {
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      transactions: [transaction],
    });
  }

  return [...groups.values()];
});

function showError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return `${error.message} (HTTP ${error.status}${error.code ? ` · ${error.code}` : ''})`;
  }
  return 'Não foi possível consultar o histórico. Verifique se a API está disponível.';
}

function kindLabel(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    OPENING: 'Abertura',
    BET: 'Aposta',
    WIN: 'Prêmio',
    LOSS: 'Perda',
    REFUND: 'Estorno',
    ROLLBACK: 'Reversão',
  };
  return labels[kind] ?? kind;
}

function statusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    PENDING: 'Pendente',
    PENDING_REFERENCE: 'Aguardando referência',
    PROCESSED: 'Processada',
    REJECTED: 'Rejeitada',
  };
  return labels[status] ?? status;
}

async function loadPage(cursor?: string): Promise<void> {
  const walletId = props.walletId;
  if (!walletId) {
    return;
  }

  const sequence = ++requestSequence;
  loading.value = true;
  errorMessage.value = null;
  try {
    const page = await wageringApi.getWalletTransactions(
      walletId,
      cursor,
      PAGE_SIZE,
    );
    if (sequence !== requestSequence || walletId !== props.walletId) {
      return;
    }
    transactions.value = cursor
      ? [...transactions.value, ...page.items]
      : [...page.items];
    nextCursor.value = page.nextCursor;
  } catch (error) {
    if (sequence === requestSequence && walletId === props.walletId) {
      errorMessage.value = showError(error);
    }
  } finally {
    if (sequence === requestSequence) {
      loading.value = false;
    }
  }
}

function refreshHistory(): void {
  void loadPage();
}

function loadMore(): void {
  if (nextCursor.value) {
    void loadPage(nextCursor.value);
  }
}

watch([() => props.walletId, () => props.active], ([walletId, active]) => {
  requestSequence += 1;
  transactions.value = [];
  nextCursor.value = null;
  errorMessage.value = null;
  if (walletId && active !== false) {
    void loadPage();
  }
}, { immediate: true });
</script>

<template>
  <section class="workspace-card workspace-card-wide history-workspace">
    <div class="workspace-card-heading history-heading">
      <div>
        <p class="section-kicker">DADOS PERSISTIDOS NO POSTGRESQL</p>
        <h2>Extrato da carteira</h2>
      </div>
      <button
        v-if="props.walletId"
        class="secondary-button compact-button"
        type="button"
        :disabled="loading"
        @click="refreshHistory"
      >
        {{ loading ? 'Consultando…' : 'Atualizar extrato' }}
      </button>
    </div>

    <div v-if="!props.walletId" class="history-empty">
      <strong>Selecione uma carteira para consultar o extrato.</strong>
      <p>As transações e rodadas são carregadas da API e permanecem disponíveis após fechar o navegador.</p>
      <button class="primary-button" type="button" @click="emit('return-to-game')">
        Ir para Jogo
      </button>
    </div>

    <template v-else>
      <div class="history-controls">
        <div class="lookup-tabs" role="group" aria-label="Formato do extrato">
          <button
            id="history-transactions-tab"
            type="button"
            :aria-pressed="viewMode === 'transactions'"
            :class="{ 'lookup-active': viewMode === 'transactions' }"
            @click="viewMode = 'transactions'"
          >
            Transações
          </button>
          <button
            id="history-rounds-tab"
            type="button"
            :aria-pressed="viewMode === 'rounds'"
            :class="{ 'lookup-active': viewMode === 'rounds' }"
            @click="viewMode = 'rounds'"
          >
            Rodadas
          </button>
        </div>
        <span class="history-count">{{ transactions.length }} registros carregados</span>
      </div>

      <p v-if="errorMessage" class="workspace-message message-error" role="alert">
        {{ errorMessage }}
      </p>
      <div v-if="loading && transactions.length === 0" class="history-empty" role="status">
        Consultando o histórico salvo da carteira…
      </div>
      <div v-else-if="!loading && transactions.length === 0 && !errorMessage" class="history-empty">
        <strong>Nenhuma transação encontrada.</strong>
        <p>As operações confirmadas pela API aparecerão aqui.</p>
      </div>

      <div
        v-else-if="viewMode === 'transactions' && transactions.length"
        class="history-table-wrap"
      >
        <table class="history-table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Operação</th>
              <th>Rodada / jogo</th>
              <th>Valor</th>
              <th>Estado</th>
              <th>Saldo registrado</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="transaction in transactions" :key="transaction.transactionId">
              <td>{{ formatTimestamp(transaction.createdAt) }}</td>
              <td>
                <strong>{{ kindLabel(transaction.kind) }}</strong>
                <span class="history-secondary">{{ transaction.externalTransactionId }}</span>
              </td>
              <td>
                <strong>{{ transaction.roundId }}</strong>
                <span class="history-secondary">{{ transaction.gameId }}</span>
              </td>
              <td>{{ transaction.money.amount }} {{ transaction.money.currency }}</td>
              <td>
                <span class="history-status" :class="'history-status-' + transaction.status.toLowerCase()">
                  {{ statusLabel(transaction.status) }}
                </span>
                <span v-if="transaction.failureCode" class="history-secondary">{{ transaction.failureCode }}</span>
              </td>
              <td>
                {{ transaction.balance
                  ? `${transaction.balance.amount} ${transaction.balance.currency}`
                  : 'Ainda sem saldo final' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="viewMode === 'rounds' && transactions.length" class="round-list">
        <article v-for="group in roundGroups" :key="`${group.gameId}-${group.roundId}`" class="round-card">
          <header class="round-card-heading">
            <div>
              <span class="section-kicker">RODADA</span>
              <h3>{{ group.roundId }}</h3>
              <span class="history-secondary">Jogo: {{ group.gameId }}</span>
            </div>
            <span class="history-count">{{ group.transactions.length }} operações</span>
          </header>
          <div class="round-transactions">
            <div v-for="transaction in group.transactions" :key="transaction.transactionId" class="round-transaction">
              <span>{{ kindLabel(transaction.kind) }} · {{ statusLabel(transaction.status) }}</span>
              <strong>{{ transaction.money.amount }} {{ transaction.money.currency }}</strong>
              <time :datetime="transaction.createdAt">{{ formatTimestamp(transaction.createdAt) }}</time>
            </div>
          </div>
        </article>
      </div>

      <div v-if="nextCursor" class="history-pagination">
        <button class="secondary-button" type="button" :disabled="loading" @click="loadMore">
          {{ loading ? 'Carregando…' : 'Carregar transações anteriores' }}
        </button>
      </div>
    </template>
  </section>
</template>
