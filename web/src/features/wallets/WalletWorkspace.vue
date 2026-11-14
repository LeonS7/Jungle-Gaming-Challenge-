<!-- Esta página abre e consulta carteiras, ledger e consistência do saldo. Assinatura: Leonardo de Souza da Luz -->
<script setup lang="ts">
import { ref } from 'vue';
import { ApiRequestError, wageringApi, type LedgerEntryView, type ReconciliationView, type WalletView } from '../../api/wagering-api';

const props = defineProps<{ readonly wallet: WalletView | null }>();
const emit = defineEmits<{ (event: 'wallet-selected', wallet: WalletView): void }>();

const playerId = ref('');
const initialAmount = ref('100.00');
const currency = ref('BRL');
const lookupId = ref('');
const ledger = ref<LedgerEntryView[]>([]);
const nextCursor = ref<string | null>(null);
const reconciliation = ref<ReconciliationView | null>(null);
const busy = ref(false);
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

function showError(error: unknown): void {
  errorMessage.value = error instanceof ApiRequestError
    ? `${error.message} (HTTP ${error.status}${error.code ? ` · ${error.code}` : ''})`
    : 'Não foi possível concluir a solicitação. Verifique se a API está disponível.';
}

async function createWallet(): Promise<void> {
  errorMessage.value = null;
  successMessage.value = null;
  if (!/^\d{1,28}\.\d{2}$/.test(initialAmount.value) || !playerId.value.trim() || !currency.value.trim()) {
    errorMessage.value = 'Informe o jogador, uma moeda e um saldo com duas casas decimais.';
    return;
  }
  const confirmed = window.confirm(
    `Criar uma carteira para ${playerId.value.trim()} com saldo inicial de ${initialAmount.value} ${currency.value.trim()}? Esta ação será gravada no banco local.`,
  );
  if (!confirmed) return;

  busy.value = true;
  try {
    const created = await wageringApi.createWallet(playerId.value.trim(), {
      amount: initialAmount.value,
      currency: currency.value.trim().toUpperCase(),
    });
    lookupId.value = created.id;
    ledger.value = [];
    reconciliation.value = null;
    emit('wallet-selected', created);
    successMessage.value = 'Carteira criada e selecionada para as próximas operações.';
    await loadLedger(created.id);
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}

async function findWallet(): Promise<void> {
  errorMessage.value = null;
  successMessage.value = null;
  if (!lookupId.value.trim()) {
    errorMessage.value = 'Informe o identificador da carteira.';
    return;
  }
  busy.value = true;
  try {
    const found = await wageringApi.getWallet(lookupId.value.trim());
    emit('wallet-selected', found);
    ledger.value = [];
    nextCursor.value = null;
    reconciliation.value = null;
    successMessage.value = 'Carteira carregada.';
    await loadLedger(found.id);
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}

async function loadLedger(walletId: string, cursor?: string): Promise<void> {
  try {
    const page = await wageringApi.getWalletLedger(walletId, cursor);
    ledger.value = cursor ? [...ledger.value, ...page.items] : [...page.items];
    nextCursor.value = page.nextCursor;
  } catch (error) {
    showError(error);
  }
}

async function loadMoreLedger(): Promise<void> {
  if (!props.wallet || !nextCursor.value) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    await loadLedger(props.wallet.id, nextCursor.value);
  } finally {
    busy.value = false;
  }
}

async function reconcile(): Promise<void> {
  if (!props.wallet) return;
  busy.value = true;
  errorMessage.value = null;
  successMessage.value = null;
  try {
    reconciliation.value = await wageringApi.reconcileWallet(props.wallet.id);
    successMessage.value = 'Reconciliação concluída. Nenhum saldo foi alterado.';
  } catch (error) {
    showError(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="workspace-grid">
    <section class="workspace-card">
      <div class="workspace-card-heading">
        <div><p class="section-kicker">NOVO CLIENTE</p><h2>Abrir carteira</h2></div>
        <span class="workspace-icon" aria-hidden="true">＋</span>
      </div>
      <p class="workspace-help">O identificador do jogador é definido por você. Uma carteira por jogador e moeda.</p>
      <form class="form-stack" @submit.prevent="createWallet">
        <label>Identificador do jogador<input v-model="playerId" autocomplete="off" placeholder="ex.: jogador-teste-01" required /></label>
        <div class="form-row">
          <label>Saldo inicial<input v-model="initialAmount" inputmode="decimal" autocomplete="off" required /></label>
          <label>Moeda<input v-model="currency" maxlength="3" autocomplete="off" required /></label>
        </div>
        <p class="field-hint">Use valor decimal em texto, por exemplo 100.00. O saldo pode ser 0.00.</p>
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Processando…' : 'Criar carteira' }}</button>
      </form>
    </section>

    <section class="workspace-card">
      <div class="workspace-card-heading">
        <div><p class="section-kicker">CONSULTA</p><h2>Selecionar carteira</h2></div>
        <span class="workspace-icon" aria-hidden="true">⌕</span>
      </div>
      <p class="workspace-help">Pesquise uma carteira existente pelo identificador retornado na criação.</p>
      <form class="form-stack" @submit.prevent="findWallet">
        <label>Identificador da carteira<input v-model="lookupId" autocomplete="off" placeholder="UUID da carteira" required /></label>
        <button class="secondary-button" type="submit" :disabled="busy">{{ busy ? 'Consultando…' : 'Consultar carteira' }}</button>
      </form>
      <div v-if="props.wallet" class="wallet-summary" aria-live="polite">
        <div><span>Saldo atual</span><strong>{{ props.wallet.balance.amount }} {{ props.wallet.balance.currency }}</strong></div>
        <dl><div><dt>Jogador</dt><dd>{{ props.wallet.playerId }}</dd></div><div><dt>Carteira</dt><dd class="mono-value">{{ props.wallet.id }}</dd></div><div><dt>Versão</dt><dd>{{ props.wallet.version }}</dd></div></dl>
      </div>
    </section>

    <section class="workspace-card workspace-card-wide">
      <div class="workspace-card-heading">
        <div><p class="section-kicker">REGISTRO IMUTÁVEL</p><h2>Ledger e reconciliação</h2></div>
        <button class="secondary-button compact-button" type="button" :disabled="busy || !props.wallet" @click="reconcile">Reconciliar carteira</button>
      </div>
      <p class="workspace-help">O ledger é somente leitura. A reconciliação compara o saldo persistido com os lançamentos; ela nunca corrige dados.</p>
      <div v-if="reconciliation" class="reconciliation-result" :class="reconciliation.consistent ? 'result-good' : 'result-bad'" role="status">
        <strong>{{ reconciliation.consistent ? 'Saldos consistentes' : 'Divergência encontrada' }}</strong>
        <span>Persistido: {{ reconciliation.storedBalance.amount }} {{ reconciliation.storedBalance.currency }}</span>
        <span>Calculado: {{ reconciliation.calculatedBalance.amount }} {{ reconciliation.calculatedBalance.currency }}</span>
        <span>Diferença: {{ reconciliation.difference.amount }} {{ reconciliation.difference.currency }}</span>
        <span>{{ reconciliation.checkedEntries }} lançamentos verificados</span>
      </div>
      <div v-if="ledger.length" class="ledger-table-wrap">
        <table class="ledger-table">
          <thead><tr><th>Data</th><th>Tipo</th><th>Valor</th><th>Saldo após</th><th>Transação</th></tr></thead>
          <tbody>
            <tr v-for="entry in ledger" :key="entry.id">
              <td>{{ new Date(entry.createdAt).toLocaleString('pt-BR') }}</td>
              <td>{{ entry.direction }}</td>
              <td>{{ entry.money.amount }} {{ entry.money.currency }}</td>
              <td>{{ entry.balanceAfter.amount }} {{ entry.balanceAfter.currency }}</td>
              <td class="mono-value">{{ entry.transactionId }}</td>
            </tr>
          </tbody>
        </table>
        <button v-if="nextCursor" class="secondary-button load-more-button" type="button" :disabled="busy" @click="loadMoreLedger">Carregar lançamentos anteriores</button>
      </div>
      <div v-else-if="props.wallet" class="empty-workspace">Esta carteira ainda não possui lançamentos para exibir.</div>
      <div v-else class="empty-workspace">Crie ou selecione uma carteira para consultar o ledger.</div>
    </section>

    <div v-if="errorMessage" class="workspace-message message-error" role="alert">{{ errorMessage }}</div>
    <div v-if="successMessage" class="workspace-message message-success" role="status">{{ successMessage }}</div>
  </div>
</template>
