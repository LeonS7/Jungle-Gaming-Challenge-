# Distributed Wagering Processor

Implementação incremental do desafio técnico da Jungle Gaming. O projeto usa Bun 1.x, NestJS, TypeScript strict, PostgreSQL e SQS por LocalStack.

## Pré-requisitos

- Bun 1.x
- Docker com Docker Compose

## Executar localmente

No PowerShell:

```powershell
Copy-Item .env.example .env
bun install
docker compose up -d postgres localstack
bun run db:migrate
bun run check
bun test --timeout=60000
bun run start
```

`bun install` resolve as dependências e cria o `bun.lock`, que deve ser versionado junto com o projeto. Os testes de integração usam o PostgreSQL do Compose e criam um schema temporário isolado.

Para reverter a última migration localmente, use `bun run db:migrate:down`. Essa operação remove as tabelas criadas pela migration e seus dados; não a execute em um banco com dados que precisem ser preservados.

A aplicação escuta somente em `http://127.0.0.1:3000` por padrão. Os endpoints de health são:

- `GET /health/live`: confirma que o processo responde.
- `GET /health/ready`: confirma que PostgreSQL e a fila SQS estão acessíveis.

As credenciais em `.env.example` são somente para o ambiente local. Não use esses valores fora dele.

## Entrada HTTP de wagering

`POST /wagering/transactions` aceita `Idempotency-Key` no cabeçalho e os tipos `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. O corpo exige IDs, rodada, jogo e `money.amount` como string com exatamente duas casas decimais; campos desconhecidos são rejeitados. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`; `WIN` pode informar essa referência. Sem referência, um `WIN` credita a carteira; com referência ausente ou ainda não finalizada, a transação fica `PENDING_REFERENCE`, sem movimentar saldo. `LOSS` é registrada como processada e guarda o saldo observado, sem alterar a carteira nem criar lançamento no ledger.

`REFUND` credita o valor de uma `BET` processada. `ROLLBACK` aplica a direção inversa de uma `BET`, `WIN` ou `REFUND` processada. Nas reversões, a referência precisa corresponder ao provedor, jogador, carteira, rodada, valor e moeda. Para `WIN` com referência, o domínio exige uma `BET` processada compatível e a mesma moeda. Uma referência inválida termina em rejeição; a mesma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.

O serviço calcula SHA-256 de um JSON com chaves em ordem fixa, contendo provedor, identificador externo, jogador, carteira, rodada, jogo, tipo, referência externa quando informada e dinheiro normalizado. A chave de idempotência e metadados HTTP não entram no hash. Não envie `payloadHash` no corpo.

- `200`: transação processada ou rejeitada por regra de negócio; confira `status` e `failureCode` no corpo. Saldo insuficiente em `BET` e saldo insuficiente para o débito de `REFUND`/`ROLLBACK` são respostas terminais `REJECTED`.
- `202`: referência informada ainda não está disponível ou processada. A resposta não inclui saldo porque nenhuma movimentação ocorreu. O estado e um evento de outbox são persistidos na mesma transação PostgreSQL.
- `400`: corpo, cabeçalho ou dinheiro inválido.
- `404`: carteira inexistente ou que não pertence ao jogador informado.
- `422`: moeda da operação diferente da moeda da carteira.
- `409`: chave reutilizada com dados diferentes ou identificador externo já registrado.
- `503`: indisponibilidade transitória conhecida do PostgreSQL.
- `500`: falha interna inesperada, sem detalhes financeiros na resposta.

A rota ainda não tem autenticação. A decisão e o ponto de extensão para um provedor de identidade externo estão documentados em `ARCHITECTURE.md`.

`POST /wallets` cria uma carteira com `playerId` e `initialBalance` (`amount` decimal como string com duas casas e `currency` ISO-4217). Responde `201` com `id`, `playerId`, `balance` e `version`; duplicidade por jogador e moeda responde `409`. Um saldo inicial positivo cria `OPENING` e um crédito de ledger; saldo zero não cria movimento financeiro.

## Consultas HTTP

- `GET /wallets/:walletId` retorna `id`, `playerId`, `balance` e `version` da carteira. Carteira inexistente responde `404`.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50` retorna lançamentos do mais recente para o mais antigo. O limite padrão é 50 e o máximo é 100. `nextCursor` é opaco e deve ser enviado sem alterações na próxima página; ele é vinculado à carteira e usa a data completa e o ID do lançamento para manter a paginação estável.
- `GET /wallets/:walletId/transactions?cursor=...&limit=50` retorna o histórico persistido de transações da carteira, do mais recente para o mais antigo. O limite padrão é 50 e o máximo é 100. `nextCursor` é opaco, vinculado à carteira e permite continuar a consulta após atualizar ou fechar o navegador. A operação é somente leitura e não expõe a chave de idempotência nem o hash interno do payload.
- `GET /wagering/transactions/:transactionId` consulta pelo ID interno da transação.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId` consulta pela identidade externa do provedor.

As consultas retornam valores monetários como strings com duas casas decimais. O contrato da consulta paginada está em `docs/openapi.yaml`. As respostas de transação não expõem a chave de idempotência nem o hash interno do payload.

`POST /wallets/:walletId/reconciliation` compara o saldo gravado com a reconstrução `créditos - débitos` do ledger imutável. A resposta contém os dois saldos, a diferença (`saldo gravado - saldo calculado`), `consistent` e `checkedEntries`. Divergências são registradas em log sem valores financeiros e incrementam `wallet_reconciliation_divergences_total`; o endpoint `GET /metrics` expõe o contador em formato Prometheus. A reconciliação não corrige dados automaticamente.

## Estado atual

A fundação inclui configuração validada, health checks, PostgreSQL e LocalStack no Compose. O domínio contém `Money`, `Wallet`, `WagerTransaction` e `WalletLedgerEntry`. Migrations reversíveis definem unicidade, saldo não negativo, transições de estado e imutabilidade do ledger.

As APIs HTTP de escrita e consulta estão implementadas para abertura de carteira, `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. As consultas usam PostgreSQL e não alteram estado financeiro. A consulta de ledger usa paginação por chave `(created_at, id)`, sem `OFFSET`, para evitar repetir ou pular registros quando houver timestamps iguais.

O processamento financeiro usa persistência PostgreSQL e outbox transacional. Cada operação bloqueia somente sua carteira com `FOR UPDATE`. O movimento de saldo, o lançamento imutável, o resultado terminal e os eventos são gravados na mesma transação SQL. Saldo insuficiente gera rejeição sem lançamento e sem débito/crédito parcial. Para `LOSS`, o serviço registra o resultado terminal e o saldo observado sem alterar a carteira nem o ledger. A chave global de idempotência e a unicidade por `(providerId, externalTransactionId)` são garantidas no banco. Repetições idempotentes devolvem o saldo histórico gravado sem duplicar eventos, e dados diferentes com a mesma chave são rejeitados.

Os eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` são armazenados em `outbox_messages` como envelopes JSON versionados. Uma referência ausente ou ainda pendente leva a transação a `PENDING_REFERENCE`, sem movimentação de saldo; uma repetição retorna o mesmo estado e não duplica o evento. Um worker PostgreSQL tenta resolver referências pendentes com backoff exponencial de 1 segundo até 5 minutos e prazo total de 24 horas. Ao expirar, a transação termina como `REJECTED` com `REFERENCE_EXPIRED`. A sequência da outbox preserva o evento inicial pendente antes do resultado final e da alteração de saldo. `LOSS` não gera `WalletBalanceChanged`; abertura de carteira com saldo positivo gera os eventos de `OPENING`, e saldo inicial zero não gera evento. Um publisher separado publica a outbox em `wager-events.fifo` depois do commit financeiro.

A entrada SQS usa a fila `wager-transactions.fifo` e um consumidor que valida o mesmo contrato de wagering da API HTTP por meio do parser de comando compartilhado na Application. A inbox persiste `(consumer_name, message_id)` e o hash do corpo original; a linha da inbox, transação financeira, ledger e outbox confirmam ou revertem juntos. O consumidor apaga a mensagem da fila somente depois do commit. Redelivery com o mesmo ID e conteúdo é confirmada sem repetir efeitos; o mesmo ID com conteúdo diferente vai para a DLQ. Erros de negócio terminais são registrados na inbox e confirmados; falhas de persistência mantêm a mensagem para retry com backoff exponencial e a política de redrive da fila. Mensagens inválidas são enviadas à DLQ antes da exclusão da fila de entrada, com deduplicação pelo ID SQS de origem para preservar mensagens distintas que tenham o mesmo corpo.

O publisher da outbox reclama linhas com `FOR UPDATE SKIP LOCKED` e lease persistido em `lock_token`/`locked_until`. Publica cada envelope com o ID do evento como identificador de deduplicação e o ID da transação como grupo FIFO, preservando a ordem dos eventos daquela transação. Falhas recebem retry com backoff exponencial limitado a 60 segundos; os eventos permanecem no PostgreSQL até a publicação ser confirmada. A entrega é *at-least-once*: uma queda depois do envio e antes de gravar `published_at` pode causar redelivery, por isso o ID do evento permanece estável.

No encerramento, o consumidor cancela long polling e aguarda a mensagem em andamento concluir ou falhar; um heartbeat estende a visibilidade durante o processamento. Há um consumidor sequencial por processo; múltiplos processos podem executar em paralelo, com o PostgreSQL mantendo a concorrência financeira por carteira. A inbox ainda não tem política de expurgo, pois apagar IDs antigos reduziria a janela de deduplicação. FIFO do SQS não é usado como garantia de consistência financeira.

A Fase 7 acrescenta reprocessamento automático e auditável de referências fora de ordem, prazo de expiração, backoff, reconciliação HTTP do ledger e contador Prometheus para divergências. Os testes de integração verificam a concorrência do worker PostgreSQL e o contrato HTTP de reconciliação. O contador Prometheus é local por processo e reinicia com a aplicação; cada réplica deve ser coletada separadamente e agregada pelo monitoramento.

## Observabilidade e validação distribuída

`GET /metrics` expõe métricas Prometheus para estados de transação, repetições por idempotência, inbox ou identidade externa do provedor, retries por referência/SQS/outbox, mensagens visíveis na DLQ, conflitos de lock PostgreSQL, duração da aquisição do lock da carteira, atraso da outbox e duração do processamento financeiro. A métrica `wallet_reconciliation_divergences_total` registra divergências encontradas pela reconciliação. Os rótulos têm valores limitados; IDs, chaves e valores monetários não são usados como rótulos.

As métricas são locais a cada processo e reiniciam após reinício. Em várias réplicas, o coletor deve consultar cada instância e agregar as séries. A contagem da DLQ usa o atributo aproximado do SQS e é atualizada a cada 10 segundos. O histograma de lock mede a duração total da consulta PostgreSQL `SELECT ... FOR UPDATE`, incluindo a ida e volta entre processo e banco; não representa apenas o tempo de espera no servidor PostgreSQL. O atraso da outbox mede a idade do evento não publicado mais antigo.

Os logs estruturados dos caminhos HTTP, SQS e workers registram contexto de correlação e identificadores operacionais, sem valores financeiros. Liveness e readiness ficam separados: readiness verifica PostgreSQL e as filas SQS configuradas.

O teste distribuído cria três processos Bun independentes e um schema PostgreSQL temporário isolado. Ele envia 50 solicitações idênticas pelas três instâncias, verifica um único débito e saldo igual à soma do ledger, encerra os processos, inicia novas instâncias e verifica a recuperação de uma referência pendente e a ordem dos eventos da outbox. Esse cenário valida concorrência e recuperação em execução local; não é um teste de carga nem mede limites de throughput.

## Painel web local — Fase 10

O painel é organizado nas áreas **Jogo**, **Extrato** e **Laboratório de Testes**, com fundo azul-marinho, superfícies escuras, roxo elétrico, dourado e estados financeiros em verde ou vermelho. Em Jogo, a mesa **Fortune Chimp** mantém o saldo retornado pela API em destaque. O usuário envia uma BET e só pode escolher GANHAR ou PERDER depois que a API confirmar `PROCESSED`; WIN referencia a BET e LOSS envia o mesmo valor da aposta sem movimentação adicional. Extrato consulta transações persistidas e pode apresentá-las por transação ou agrupadas por jogo e rodada. O Laboratório reúne saúde e métricas da API, ledger, reconciliação, consulta técnica de transações e ensaios de idempotência. A interface não calcula saldo nem implementa regras financeiras.

Com backend, PostgreSQL e LocalStack em execução, abra outro terminal PowerShell:

```powershell
Set-Location web
Copy-Item .env.example .env
bun install
bun run dev
```

Abra `http://127.0.0.1:5173`. A raiz da API em `http://127.0.0.1:3000` também redireciona o navegador para essa interface. O cliente usa o prefixo `/api` definido por `VITE_API_BASE_URL`; o proxy de desenvolvimento encaminha esse prefixo para `http://127.0.0.1:3000`, evitando dependência de CORS na execução local. Para apontar o proxy a outro backend, altere `VITE_API_PROXY_TARGET` em `web/.env`; para alterar o destino do redirecionamento, configure `WEB_PANEL_URL` no `.env` da aplicação.

Para validar o pacote do painel, dentro de `web/`, execute `bun run check`, `bun test` e `bun run build`. Operações de gravação pedem confirmação no navegador. Os ensaios do Laboratório permitem repetir exatamente a última solicitação com a mesma chave e testar o conflito usando a mesma chave com conteúdo alterado; a garantia vem do armazenamento persistente da API, não do estado do navegador.

Os cenários guiados criam uma carteira nova de R$ 100,00 por execução e chamam a API real: duas BETs simultâneas de R$ 80,00, BET/REFUND/ROLLBACK de R$ 20,00 e WIN recebido antes da BET de referência. Eles gravam dados no PostgreSQL local e mostram somente as respostas persistidas da API. A conclusão do WIN pendente é feita pelo worker de referências fora de ordem, portanto a tela não promete resolução imediata.

O navegador guarda somente o identificador da carteira selecionada. Ao reabrir o painel, consulta a carteira pela API e o Extrato busca novamente as páginas de transações no PostgreSQL; saldos, operações e histórico não são persistidos no armazenamento local do navegador. O limite da consulta e o contrato estão descritos em `docs/openapi.yaml`.

API, painel e portas publicadas pelo Docker Compose ficam vinculados ao loopback (`127.0.0.1`). Não há autenticação por usuário: outros processos executados na mesma máquina podem chamar a API. Essa fronteira atende à demonstração local, mas não protege uma implantação em rede; não altere os vínculos para interfaces públicas nem exponha o serviço sem integrar autenticação respaldada por um provedor de identidade e controles de rede apropriados.

Verificações do backend: `bun run check`, `bun run build`, `bun test --timeout=60000` e `bun run test:integration`. A suíte requer PostgreSQL e LocalStack SQS acessíveis e cobre migrations, constraints, concorrência, idempotência, eventos, reversões, inbox, redelivery, DLQ e rollback financeiro.
