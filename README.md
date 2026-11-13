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

Os eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` são armazenados em `outbox_messages` como envelopes JSON versionados. Uma referência ausente ou ainda pendente leva a transação a `PENDING_REFERENCE`, sem movimentação de saldo; uma repetição retorna o mesmo estado e não duplica o evento. `LOSS` não gera `WalletBalanceChanged`; abertura de carteira com saldo positivo gera os eventos de `OPENING`, e saldo inicial zero não gera evento. A outbox ainda não tem publisher SQS: nenhum desses eventos é publicado nesta fase.

Ainda faltam inbox persistente, consumer e publisher SQS, reprocessamento automático de referências pendentes, reconciliação, observabilidade obrigatória e ensaios com três ou mais processos da aplicação. Os testes de concorrência desta fase usam três clientes PostgreSQL independentes; isso não equivale a três processos da aplicação. FIFO do SQS não é usado como garantia de consistência financeira.

Verificações: `bun run check`, `bun run build`, `bun test` e `bun run test:integration`. Os testes usam PostgreSQL real em schemas isolados e cobrem migrations, constraints, concorrência, idempotência, eventos, reversões e rollback financeiro quando uma gravação transacional falha. O PostgreSQL precisa estar acessível para executá-los.
