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

`POST /wagering/transactions` aceita `Idempotency-Key` no cabeçalho e `kind: "BET"`, `kind: "WIN"` ou `kind: "LOSS"`. O corpo exige IDs, rodada, jogo e `money.amount` como string com exatamente duas casas decimais; campos desconhecidos são rejeitados. Nesta fase, `WIN` é aceito sem referência externa e credita a carteira com um lançamento `CREDIT`; a resolução de referências ficará para uma fase própria. `LOSS` é registrada como processada e guarda o saldo observado, sem alterar a carteira nem criar lançamento no ledger.

O serviço calcula SHA-256 de um JSON com chaves em ordem fixa, contendo provedor, identificador externo, jogador, carteira, rodada, jogo, tipo e dinheiro normalizado. A chave de idempotência e metadados HTTP não entram no hash. Não envie `payloadHash` no corpo.

- `200`: BET, WIN ou LOSS processada, ou BET rejeitada por regra de negócio; confira `status` e `failureCode` no corpo. Saldo insuficiente é uma resposta terminal `REJECTED`.
- `400`: corpo, cabeçalho ou dinheiro inválido.
- `404`: carteira inexistente ou que não pertence ao jogador informado.
- `422`: moeda da operação diferente da moeda da carteira.
- `409`: chave reutilizada com dados diferentes ou identificador externo já registrado.
- `501`: `REFUND` ou `ROLLBACK` ainda não implementados.
- `503`: indisponibilidade transitória conhecida do PostgreSQL.
- `500`: falha interna inesperada, sem detalhes financeiros na resposta.

A rota ainda não tem autenticação. A decisão e o ponto de extensão para um provedor de identidade externo estão documentados em `ARCHITECTURE.md`.

`POST /wallets` cria uma carteira com `playerId` e `initialBalance` (`amount` decimal como string com duas casas e `currency` ISO-4217). Responde `201` com `id`, `playerId`, `balance` e `version`; duplicidade por jogador e moeda responde `409`. Um saldo inicial positivo cria `OPENING` e um crédito de ledger; saldo zero não cria movimento financeiro.

## Estado atual

A fundação inclui configuração validada, health checks, PostgreSQL e LocalStack no Compose. O domínio contém `Money`, `Wallet`, `WagerTransaction` e `WalletLedgerEntry`. Migrations reversíveis definem unicidade, saldo não negativo, transições de estado e imutabilidade do ledger.

A fase atual implementa `BET`, `WIN` sem referência e `LOSS` com persistência PostgreSQL e outbox transacional. Cada operação bloqueia somente sua carteira com `FOR UPDATE`. Para `BET`, o débito; para `WIN`, o crédito; e, em ambos, o lançamento imutável, o resultado terminal e os eventos são gravados na mesma transação SQL. Saldo insuficiente em `BET` vira rejeição sem lançamento ou débito e registra um evento de rejeição. Para `LOSS`, o serviço registra o resultado terminal e o saldo observado sem alterar a carteira nem o ledger. A chave global de idempotência e a unicidade por `(providerId, externalTransactionId)` são garantidas no banco. Repetições idempotentes devolvem o saldo histórico gravado sem duplicar eventos, e dados diferentes com a mesma chave são rejeitados.

Os eventos `WagerTransactionProcessed`, `WagerTransactionRejected` e `WalletBalanceChanged` são armazenados em `outbox_messages` como envelopes JSON versionados. `LOSS` não gera `WalletBalanceChanged`; abertura de carteira com saldo positivo gera os eventos de `OPENING`, e saldo inicial zero não gera evento. A outbox ainda não tem publisher SQS: nenhum desses eventos é publicado nesta fase.

Ainda faltam consultas de carteira, inbox, publisher da outbox, processamento SQS, resolução e reprocessamento de referências de `WIN`, operações `REFUND` e `ROLLBACK` e ensaios com três instâncias da aplicação. FIFO do SQS não é usado como garantia de consistência financeira.

Verificações: `bun run check`, `bun run build`, `bun test` e `bun run test:integration`. Os testes de integração usam PostgreSQL real, criam schemas isolados e verificam rollback de migrations, concorrência, idempotência, eventos de BET, WIN, LOSS e OPENING, imutabilidade da outbox e rollback financeiro quando a outbox falha. O PostgreSQL do Compose precisa estar acessível para executá-los.
