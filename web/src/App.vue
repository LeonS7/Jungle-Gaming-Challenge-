<!-- Esta página apresenta saúde e métricas locais da API. Assinatura: Leonardo de Souza da Luz -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import WalletWorkspace from './features/wallets/WalletWorkspace.vue';
import WageringWorkspace from './features/wagering/WageringWorkspace.vue';
import type { WalletView } from './api/wagering-api';
import {
  loadDashboardSnapshot,
  type DashboardSnapshot,
  type HealthState,
} from './api/dashboard-api';

const REFRESH_INTERVAL_MILLISECONDS = 15_000;
const snapshot = ref<DashboardSnapshot | null>(null);
const loading = ref(false);
const pageError = ref<string | null>(null);
const activeSection = ref<'overview' | 'operations'>('overview');
const selectedWallet = ref<WalletView | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | undefined;

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

onMounted(() => {
  void refreshDashboard();
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
      <nav>
        <button class="nav-item" :class="{ 'nav-item-active': activeSection === 'overview' }" type="button" :aria-current="activeSection === 'overview' ? 'page' : undefined" @click="activeSection = 'overview'">
          <span class="nav-icon" aria-hidden="true">◫</span>
          <span>Visão geral</span>
        </button>
        <button class="nav-item" :class="{ 'nav-item-active': activeSection === 'operations' }" type="button" :aria-current="activeSection === 'operations' ? 'page' : undefined" @click="activeSection = 'operations'">
          <span class="nav-icon" aria-hidden="true">↗</span>
          <span>Testar como jogador</span>
        </button>
      </nav>

      <div class="rail-footer">
        <span class="local-indicator" aria-hidden="true"></span>
        <span>Ambiente de demonstração</span>
      </div>
    </aside>

    <main id="inicio" class="main-area">
      <header class="topbar">
        <div class="breadcrumb">Jungle Gaming <span>/</span> {{ activeSection === 'overview' ? 'Visão geral' : 'Área do jogador' }}</div>
        <div class="topbar-actions">
          <span class="environment-badge"><span></span> LOCAL</span>
          <button
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

      <div id="visao-geral" class="content-area" v-show="activeSection === 'overview'">
        <section class="page-heading">
          <div>
            <p class="eyebrow">CENTRO DE OPERAÇÕES <span>•</span> AMBIENTE LOCAL</p>
            <h1>Visão geral</h1>
            <p class="page-description">
              Saúde do processador e atividade registrada nesta instância da API.
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

        <footer class="page-footer">
          <span class="footer-lock" aria-hidden="true">◈</span>
          Os indicadores são locais à instância consultada e reiniciam com o processo.
        </footer>
      </div>

      <div class="content-area operations-area" v-show="activeSection === 'operations'">
        <section class="page-heading">
          <div>
            <p class="eyebrow">AMBIENTE LOCAL <span>•</span> OPERAÇÕES REAIS</p>
            <h1>Testar como jogador</h1>
            <p class="page-description">Use as telas para criar carteiras, executar operações e consultar os resultados persistidos pela API.</p>
          </div>
          <div class="updated-at"><span class="updated-dot" aria-hidden="true"></span> API local em {{ selectedWallet ? 'uso' : 'espera' }}</div>
        </section>
        <section class="operation-screen" aria-label="Carteiras">
          <WalletWorkspace :wallet="selectedWallet" @wallet-selected="selectedWallet = $event" />
        </section>
        <section class="operation-screen operation-screen-spaced" aria-label="Wagering">
          <WageringWorkspace :wallet="selectedWallet" @wallet-refreshed="selectedWallet = $event" />
        </section>
        <footer class="page-footer operations-footer">
          <span class="footer-lock" aria-hidden="true">!</span>
          As ações gravam dados locais. Não existe botão de exclusão: lançamentos do ledger são imutáveis.
        </footer>
      </div>
    </main>
  </div>
</template>
