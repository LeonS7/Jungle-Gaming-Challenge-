<!-- Esta página organiza Jogo, Extrato e Laboratório e recupera a carteira salva pela API. Assinatura: Leonardo de Souza da Luz -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import WalletWorkspace from './features/wallets/WalletWorkspace.vue';
import WageringWorkspace from './features/wagering/WageringWorkspace.vue';
import TransactionHistoryWorkspace from './features/history/TransactionHistoryWorkspace.vue';
import {
  readSelectedWalletId,
  removeSelectedWalletId,
  saveSelectedWalletId,
} from './features/wallets/selected-wallet-storage';
import {
  ApiRequestError,
  wageringApi,
  type WalletView,
  type WagerRequest,
} from './api/wagering-api';
import {
  loadDashboardSnapshot,
  type DashboardSnapshot,
  type HealthState,
} from './api/dashboard-api';

const REFRESH_INTERVAL_MILLISECONDS = 15_000;
type MainSection = 'game' | 'statement' | 'lab';
interface LastWagerRequest {
  readonly payload: WagerRequest;
  readonly key: string;
}

const snapshot = ref<DashboardSnapshot | null>(null);
const loading = ref(false);
const pageError = ref<string | null>(null);
const activeSection = ref<MainSection>('game');
const selectedWallet = ref<WalletView | null>(null);
const lastWagerRequest = ref<LastWagerRequest | null>(null);
const restoringWallet = ref(false);
const walletContextError = ref<string | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | undefined;

const sectionLabels: Readonly<Record<MainSection, string>> = {
  game: 'Jogo',
  statement: 'Extrato',
  lab: 'Laboratório de Testes',
};

const healthCards = computed(() => {
  if (!snapshot.value) {
    return [
      { name: 'Aplicação', result: { state: 'checking', detail: 'Verificando' } as HealthState },
      { name: 'PostgreSQL', result: { state: 'checking', detail: 'Verificando' } as HealthState },
      { name: 'Amazon SQS', result: { state: 'checking', detail: 'Verificando' } as HealthState },
    ];
  }
  return [
    { name: 'Aplicação', result: snapshot.value.application },
    { name: 'PostgreSQL', result: snapshot.value.postgres },
    { name: 'Amazon SQS', result: snapshot.value.sqs },
  ];
});

const healthyServices = computed(() =>
  healthCards.value.filter(({ result }) => result.state === 'ok').length,
);

function statusLabel(state: HealthState['state']): string {
  if (state === 'ok') {
    return 'Disponível';
  }
  return state === 'checking' ? 'Verificando' : 'Indisponível';
}

function formatTimestamp(value: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZoneName: 'short',
  }).format(value);
}

function formatSeconds(value: number): string {
  if (value < 60) {
    return value.toFixed(1) + ' s';
  }
  const minutes = Math.floor(value / 60);
  const remainingSeconds = Math.round(value % 60);
  return minutes + ' min ' + remainingSeconds + ' s';
}

async function refreshDashboard(): Promise<void> {
  if (loading.value) {
    return;
  }
  loading.value = true;
  pageError.value = null;
  try {
    snapshot.value = await loadDashboardSnapshot();
  } catch {
    pageError.value = 'Não foi possível atualizar o painel. Tente novamente.';
  } finally {
    loading.value = false;
  }
}

function selectWallet(wallet: WalletView): void {
  selectedWallet.value = wallet;
  walletContextError.value = null;
  try {
    saveSelectedWalletId(window.localStorage, wallet.id);
  } catch {
    walletContextError.value = 'O navegador não conseguiu guardar o identificador da carteira para a próxima visita.';
  }
}

async function restoreSelectedWallet(): Promise<void> {
  let walletId: string | null;
  try {
    walletId = readSelectedWalletId(window.localStorage);
  } catch {
    walletContextError.value = 'O navegador bloqueou a leitura da carteira salva. Consulte-a novamente na área Jogo.';
    return;
  }
  if (!walletId) {
    return;
  }

  restoringWallet.value = true;
  walletContextError.value = null;
  try {
    selectedWallet.value = await wageringApi.getWallet(walletId);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      try {
        removeSelectedWalletId(window.localStorage);
      } catch {
        // A seleção manual continua disponível se o navegador bloquear o armazenamento.
      }
      walletContextError.value = 'A carteira salva não existe mais. Selecione ou crie outra carteira.';
    } else {
      walletContextError.value = 'Não foi possível recuperar a carteira salva. Verifique a API e tente novamente.';
    }
  } finally {
    restoringWallet.value = false;
  }
}

onMounted(() => {
  void refreshDashboard();
  void restoreSelectedWallet();
  refreshTimer = setInterval(() => void refreshDashboard(), REFRESH_INTERVAL_MILLISECONDS);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
});
</script>

<template>
  <div class="app-shell">
    <aside class="side-rail" aria-label="Navegação principal">
      <a class="brand-mark" href="#inicio" aria-label="Jungle Gaming, início">
        <span class="brand-symbol" aria-hidden="true">J</span>
        <span class="brand-name">Jungle<span>Gaming</span></span>
      </a>

      <div class="rail-caption">PAINEL LOCAL</div>
      <nav class="main-navigation" aria-label="Áreas principais">
        <button
          class="nav-item"
          :class="{ 'nav-item-active': activeSection === 'game' }"
          type="button"
          :aria-current="activeSection === 'game' ? 'page' : undefined"
          @click="activeSection = 'game'"
        >
          <span class="nav-icon" aria-hidden="true">♧</span>
          <span>Jogo</span>
        </button>
        <button
          class="nav-item"
          :class="{ 'nav-item-active': activeSection === 'statement' }"
          type="button"
          :aria-current="activeSection === 'statement' ? 'page' : undefined"
          @click="activeSection = 'statement'"
        >
          <span class="nav-icon" aria-hidden="true">▤</span>
          <span>Extrato</span>
        </button>
        <button
          class="nav-item"
          :class="{ 'nav-item-active': activeSection === 'lab' }"
          type="button"
          :aria-current="activeSection === 'lab' ? 'page' : undefined"
          @click="activeSection = 'lab'"
        >
          <span class="nav-icon" aria-hidden="true">⌁</span>
          <span>Laboratório de Testes</span>
        </button>
      </nav>

      <div class="rail-footer">
        <span class="local-indicator" aria-hidden="true"></span>
        <span>Ambiente de demonstração</span>
      </div>
    </aside>

    <main id="inicio" class="main-area">
      <header class="topbar">
        <div class="breadcrumb">Jungle Gaming <span>/</span> {{ sectionLabels[activeSection] }}</div>
        <div class="topbar-actions">
          <span class="environment-badge"><span></span> LOCAL</span>
          <button
            v-if="activeSection === 'lab'"
            class="refresh-button"
            type="button"
            :disabled="loading"
            @click="refreshDashboard"
          >
            <span class="refresh-icon" :class="{ spinning: loading }" aria-hidden="true">↻</span>
            {{ loading ? 'Atualizando' : 'Atualizar' }}
          </button>
        </div>
      </header>

      <section v-show="activeSection === 'lab'" class="content-area">
        <section class="page-heading">
          <div>
            <p class="eyebrow">FERRAMENTAS TÉCNICAS <span>•</span> AMBIENTE LOCAL</p>
            <h1>Laboratório de Testes</h1>
            <p class="page-description">
              Saúde e métricas da API, ledger, reconciliação e ferramentas de idempotência.
            </p>
          </div>
          <div class="updated-at" v-if="snapshot">
            <span class="updated-dot" aria-hidden="true"></span>
            Atualizado em {{ formatTimestamp(snapshot.updatedAt) }}
          </div>
        </section>

        <div v-if="pageError" class="alert alert-error" role="alert">
          <span class="alert-icon" aria-hidden="true">!</span>
          {{ pageError }}
        </div>

        <section class="health-section" aria-labelledby="health-title">
          <div class="section-heading">
            <div>
              <p class="section-kicker">DEPENDÊNCIAS</p>
              <h2 id="health-title">Saúde do serviço</h2>
            </div>
            <span class="health-summary">
              <span :class="healthyServices === 3 ? 'summary-dot summary-dot-good' : 'summary-dot'" aria-hidden="true"></span>
              {{ healthyServices }} de 3 disponíveis
            </span>
          </div>

          <div class="health-grid">
            <article v-for="card in healthCards" :key="card.name" class="health-card">
              <div class="health-card-top">
                <span class="health-symbol" aria-hidden="true">
                  {{ card.name === 'Aplicação' ? '◉' : card.name === 'PostgreSQL' ? '▤' : '⌁' }}
                </span>
                <span class="status-pill" :class="'status-' + card.result.state">
                  <span class="status-dot" aria-hidden="true"></span>
                  {{ statusLabel(card.result.state) }}
                </span>
              </div>
              <h3>{{ card.name }}</h3>
              <p>{{ card.result.detail || 'Aguardando consulta' }}</p>
            </article>
          </div>
        </section>

        <section class="activity-section" aria-labelledby="activity-title">
          <div class="section-heading activity-heading">
            <div>
              <p class="section-kicker">PROCESSAMENTO</p>
              <h2 id="activity-title">Atividade financeira</h2>
            </div>
            <span class="process-scope">Contadores acumulados neste processo</span>
          </div>

          <div v-if="snapshot?.metrics" class="activity-panel">
            <div class="transaction-list">
              <div
                v-for="item in snapshot.metrics.transactions"
                :key="item.status"
                class="transaction-row"
              >
                <span class="transaction-label">
                  <span class="transaction-marker" :class="'marker-' + item.status.toLowerCase()" aria-hidden="true"></span>
                  {{ item.label }}
                </span>
                <strong>{{ item.count.toLocaleString('pt-BR') }}</strong>
              </div>
            </div>
            <div class="operations-stats">
              <article class="operation-stat">
                <div class="stat-label">Mensagens visíveis na DLQ</div>
                <strong v-if="snapshot.metrics.deadLetterVisibleMessages !== null">
                  {{ snapshot.metrics.deadLetterVisibleMessages.toLocaleString('pt-BR') }}
                </strong>
                <span v-else class="stat-unavailable">Indisponível</span>
                <span class="stat-footnote">Contagem aproximada do SQS</span>
              </article>
              <article class="operation-stat">
                <div class="stat-label">Atraso da Outbox</div>
                <strong v-if="snapshot.metrics.outboxLagSeconds !== null">
                  {{ formatSeconds(snapshot.metrics.outboxLagSeconds) }}
                </strong>
                <span v-else class="stat-unavailable">Indisponível</span>
                <span class="stat-footnote">Evento pendente mais antigo</span>
              </article>
            </div>
            <p class="metrics-note" v-if="snapshot.metricsError" role="status">
              {{ snapshot.metricsError }}
            </p>
          </div>
          <div v-else class="empty-panel" role="status">
            <span class="empty-symbol" aria-hidden="true">⌁</span>
            <div>
              <strong>Métricas ainda não disponíveis</strong>
              <p>{{ snapshot?.metricsError || 'Aguardando a primeira resposta da API.' }}</p>
            </div>
          </div>
        </section>

        <section class="operation-screen operation-screen-spaced" aria-label="Ledger e reconciliação">
          <WalletWorkspace
            :wallet="selectedWallet"
            mode="laboratory"
            :active="activeSection === 'lab'"
          />
        </section>
        <section class="operation-screen operation-screen-spaced" aria-label="Ferramentas de wagering">
          <WageringWorkspace
            :wallet="selectedWallet"
            mode="laboratory"
            :last-request="lastWagerRequest"
            @wallet-refreshed="selectWallet"
          />
        </section>
        <footer class="page-footer">
          <span class="footer-lock" aria-hidden="true">◈</span>
          Os indicadores são locais à instância consultada e reiniciam com o processo.
        </footer>
      </section>

      <section v-show="activeSection === 'statement'" class="content-area operations-area">
        <section class="page-heading">
          <div>
            <p class="eyebrow">HISTÓRICO PERSISTENTE <span>•</span> API REAL</p>
            <h1>Extrato</h1>
            <p class="page-description">Consulte transações e rodadas salvas no PostgreSQL. O painel busca os dados novamente ao abrir esta área.</p>
          </div>
          <div class="updated-at"><span class="updated-dot" aria-hidden="true"></span> {{ selectedWallet ? 'Carteira selecionada' : 'Aguardando carteira' }}</div>
        </section>
        <TransactionHistoryWorkspace
          :wallet-id="selectedWallet?.id ?? null"
          :active="activeSection === 'statement'"
          @return-to-game="activeSection = 'game'"
        />
        <footer class="page-footer">
          <span class="footer-lock" aria-hidden="true">◈</span>
          A lista vem da API; o navegador guarda somente o identificador da carteira selecionada.
        </footer>
      </section>

      <section v-show="activeSection === 'game'" class="content-area operations-area">
        <section class="page-heading">
          <div>
            <p class="eyebrow">EXPERIÊNCIA PRINCIPAL <span>•</span> OPERAÇÕES REAIS</p>
            <h1>Jogo</h1>
            <p class="page-description">Selecione sua carteira e envie operações pela API. As decisões financeiras continuam no backend.</p>
          </div>
          <div class="updated-at"><span class="updated-dot" aria-hidden="true"></span> API local em {{ selectedWallet ? 'uso' : 'espera' }}</div>
        </section>
        <div v-if="restoringWallet" class="workspace-message message-success" role="status">
          Recuperando a carteira salva pela API…
        </div>
        <div v-else-if="walletContextError" class="workspace-message message-error" role="alert">
          <span>{{ walletContextError }}</span>
          <button
            v-if="!selectedWallet"
            class="secondary-button compact-button"
            type="button"
            @click="restoreSelectedWallet"
          >
            Tentar recuperar carteira
          </button>
        </div>
        <section class="operation-screen" aria-label="Carteiras">
          <WalletWorkspace
            :wallet="selectedWallet"
            mode="player"
            @wallet-selected="selectWallet"
          />
        </section>
        <section class="operation-screen operation-screen-spaced" aria-label="Wagering">
          <WageringWorkspace
            :wallet="selectedWallet"
            mode="game"
            :last-request="lastWagerRequest"
            @wallet-refreshed="selectWallet"
            @last-request-changed="lastWagerRequest = $event"
            @open-statement="activeSection = 'statement'"
          />
        </section>
        <footer class="page-footer operations-footer">
          <span class="footer-lock" aria-hidden="true">!</span>
          As operações gravam dados no PostgreSQL local. O saldo e as regras são processados pela API.
        </footer>
      </section>
    </main>
  </div>
</template>
