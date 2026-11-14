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
bun test
bun run start
```

`bun install` resolve as dependências e cria o `bun.lock`, que deve ser versionado junto com o projeto. Os testes de integração usam o PostgreSQL do Compose e criam um schema temporário isolado.

Para reverter a última migration localmente, use `bun run db:migrate:down`. Essa operação remove as tabelas criadas pela migration e seus dados; não a execute em um banco com dados que precisem ser preservados.

A aplicação escuta em `http://localhost:3000` por padrão. Os endpoints de health são:

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
- `GET /wagering/transactions/:transactionId` consulta pelo ID interno da transação.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId` consulta pela identidade externa do provedor.

As consultas retornam valores monetários como strings com duas casas decimais. As respostas de transação não expõem a chave de idempotência nem o hash interno do payload.

## Estado atual

A fundação inclui configuração validada, health checks, PostgreSQL e LocalStack no Compose. O domínio contém `Money`, `Wallet`, `WagerTransaction` e `WalletLedgerEntry`. Migrations reversíveis definem unicidade, saldo não negativo, transições de estado e imutabilidade do ledger.

As APIs HTTP de escrita e consulta estão implementadas para abertura de carteira, `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. As consultas usam PostgreSQL e não alteram estado financeiro. A consulta de ledger usa paginação por chave `(created_at, id)`, sem `OFFSET`, para evitar repetir ou pular registros quando houver timestamps iguais.

O processamento financeiro usa persistência PostgreSQL e outbox transacional. Cada operação bloqueia somente sua carteira com `FOR UPDATE`. O movimento de saldo, o lançamento imutável, o resultado terminal e os eventos são gravados na mesma transação SQL. Saldo insuficiente gera rejeição sem lançamento e sem débito/crédito parcial. Para `LOSS`, o serviço registra o resultado terminal e o saldo observado sem alterar a carteira nem o ledger. A chave global de idempotência e a unicidade por `(providerId, externalTransactionId)` são garantidas no banco. Repetições idempotentes devolvem o saldo histórico gravado sem duplicar eventos, e dados diferentes com a mesma chave são rejeitados.

Os eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` são armazenados em `outbox_messages` como envelopes JSON versionados. Uma referência ausente ou ainda pendente leva a transação a `PENDING_REFERENCE`, sem movimentação de saldo; uma repetição retorna o mesmo estado e não duplica o evento. `LOSS` não gera `WalletBalanceChanged`; abertura de carteira com saldo positivo gera os eventos de `OPENING`, e saldo inicial zero não gera evento. Um publisher separado publica a outbox em `wager-events.fifo` depois do commit financeiro.

A entrada SQS usa a fila `wager-transactions.fifo` e um consumidor que valida o mesmo contrato de wagering da API HTTP por meio do parser de comando compartilhado na Application. A inbox persiste `(consumer_name, message_id)` e o hash do corpo original; a linha da inbox, transação financeira, ledger e outbox confirmam ou revertem juntos. O consumidor apaga a mensagem da fila somente depois do commit. Redelivery com o mesmo ID e conteúdo é confirmada sem repetir efeitos; o mesmo ID com conteúdo diferente vai para a DLQ. Erros de negócio terminais são registrados na inbox e confirmados; falhas de persistência mantêm a mensagem para retry com backoff exponencial e a política de redrive da fila. Mensagens inválidas são enviadas à DLQ antes da exclusão da fila de entrada, com deduplicação pelo ID SQS de origem para preservar mensagens distintas que tenham o mesmo corpo.

O publisher da outbox reclama linhas com `FOR UPDATE SKIP LOCKED` e lease persistido em `lock_token`/`locked_until`. Publica cada envelope com o ID do evento como identificador de deduplicação e o ID da transação como grupo FIFO, preservando a ordem dos eventos daquela transação. Falhas recebem retry com backoff exponencial limitado a 60 segundos; os eventos permanecem no PostgreSQL até a publicação ser confirmada. A entrega é *at-least-once*: uma queda depois do envio e antes de gravar `published_at` pode causar redelivery, por isso o ID do evento permanece estável.

No encerramento, o consumidor cancela long polling e aguarda a mensagem em andamento concluir ou falhar; um heartbeat estende a visibilidade durante o processamento. Há um consumidor sequencial por processo; múltiplos processos podem executar em paralelo, com o PostgreSQL mantendo a concorrência financeira por carteira. A inbox ainda não tem política de expurgo, pois apagar IDs antigos reduziria a janela de deduplicação. FIFO do SQS não é usado como garantia de consistência financeira.

Ainda faltam reprocessamento automático de referências pendentes, reconciliação, métricas obrigatórias e ensaios de ponta a ponta com três ou mais processos da aplicação. Os testes da Fase 6 cobrem três clientes PostgreSQL concorrentes para inbox, consumidor e publisher LocalStack reais, dois publishers sobre a mesma outbox, recuperação após lease vencido, falha entre envio e confirmação, retry e rollback de inbox junto com estado financeiro.

Verificações: `bun run check`, `bun run build`, `bun test` e `bun run test:integration`. Os testes usam PostgreSQL e LocalStack SQS reais em schemas/filas isolados e cobrem migrations, constraints, concorrência, idempotência, eventos, reversões, inbox, redelivery, DLQ e rollback financeiro quando uma gravação transacional falha. PostgreSQL e LocalStack precisam estar acessíveis para executar a suíte completa.
