# Jungle Gaming — Instruções completas para o Codex

> **Objetivo:** usar este documento como briefing principal do Codex no aplicativo Codex para construir, passo a passo, o desafio técnico **Distributed Wagering Processor**, da Jungle Gaming.
>
> **Como usar:** coloque este arquivo na raiz do repositório. Se você tiver o enunciado original, salve-o também como `CHALLENGE.md` na raiz. Depois, abra o projeto no Codex e envie o prompt da seção **1**. Não peça para implementar tudo de uma vez.

---

# 1. Primeiro prompt para enviar ao Codex

Copie e envie este texto ao Codex depois de abrir a pasta do projeto:

```text
Leia integralmente os arquivos CODEX_INSTRUCOES.md e CHALLENGE.md (se existir) antes de alterar qualquer coisa.

Você será meu parceiro de engenharia para implementar o desafio técnico Distributed Wagering Processor da Jungle Gaming.

REGRAS DE TRABALHO:
1. Não implemente o projeto inteiro de uma vez. Trabalhe por fases pequenas e verificáveis.
2. Antes de cada fase, explique:
   - o objetivo da fase;
   - os requisitos do desafio que ela atende;
   - a abordagem técnica proposta;
   - os arquivos que pretende criar ou alterar;
   - riscos, decisões e trade-offs.
3. Aguarde minha autorização antes de começar cada fase. Não avance automaticamente para a próxima.
4. Escreva código que eu consiga entender e defender em uma entrevista. Explique conceitos importantes sem esconder complexidade.
5. Não invente requisitos, resultados de testes ou funcionalidades. Se algo estiver incompleto, diga claramente.
6. Não remova testes para fazer a suíte passar. Não enfraqueça constraints nem substitua integrações reais por mocks para aparentar conclusão.
7. Sempre execute os testes e verificações relevantes após cada implementação. Informe os comandos e resultados reais.
8. Atualize README.md e ARCHITECTURE.md conforme as decisões forem tomadas.
9. Se houver ambiguidade no desafio, apresente as interpretações possíveis e recomende uma, sem decidir silenciosamente.
10. Preserve uma implementação simples, explícita e auditável. Não adicione abstrações, bibliotecas ou infraestrutura sem justificativa.

STACK OBRIGATÓRIA:
- Bun 1.x como runtime, package manager e test runner.
- TypeScript em modo strict.
- NestJS.
- PostgreSQL.
- AWS SQS por LocalStack ou MiniStack.
- Docker Compose.
- Migrations versionadas e reversíveis.
- MikroORM preferencial ou TypeORM aceito. Não use Prisma nem outro ORM fora das opções do desafio.
- decimal.js (ou solução decimal equivalente devidamente justificada) para aritmética monetária.

RESTRIÇÕES CRÍTICAS:
- Nunca use number, float ou double para representar dinheiro ou fazer cálculos monetários.
- Dinheiro deve entrar, persistir e sair como decimal string com duas casas.
- Não use cache em memória como garantia de idempotência.
- Não confie apenas no FIFO do SQS para garantir consistência.
- Não publique eventos antes do commit financeiro.
- Não altere nem apague registros do ledger.
- Não use lock global.
- Não faça read-calculate-update sem controle de concorrência.
- A solução precisa funcionar com três ou mais instâncias.
- Implemente garantias de unicidade, imutabilidade e saldo não negativo também no schema do PostgreSQL.
- Wallet, ledger, transação, inbox e outbox precisam ser consistentes e transacionais conforme o fluxo de entrada.
- Não declare uma fase concluída sem testes e evidências.

ARQUITETURA DESEJADA:
Use uma arquitetura inspirada em DDD e Clean Architecture, sem exagerar nas camadas:
- Domain: entidades, value objects, enums, regras e erros de domínio.
- Application: casos de uso, orquestração e portas/interfaces.
- Infrastructure: PostgreSQL/ORM, repositories, migrations, SQS, inbox, outbox, workers e observabilidade.
- Presentation: controllers HTTP, DTOs, validação e health checks.
- Shared: utilitários e erros compartilhados realmente necessários.

O domínio não deve depender de NestJS, ORM, SQS ou detalhes HTTP. Prefira construtores privados/protected e factories estáticas create/from/rehydrate. A factory rehydrate reconstrói estado persistido sem executar novamente regras de transição de negócio.

PRIMEIRA TAREFA:
Não comece a implementar. Primeiro:
1. leia os documentos;
2. apresente um resumo dos requisitos;
3. proponha a estrutura inicial do repositório;
4. divida a implementação em fases;
5. identifique riscos técnicos, especialmente concorrência, idempotência, reversões e atomicidade;
6. liste dúvidas ou decisões que precisam da minha aprovação.
Depois aguarde minha autorização.
```

---

# 2. Contexto e objetivo do desafio

Construir um serviço financeiro distribuído que recebe transações de apostas de múltiplos provedores de jogos e processa os tipos:

- `BET`
- `WIN`
- `LOSS`
- `REFUND`
- `ROLLBACK`

O desafio não é um CRUD. A avaliação se concentra em:

1. correção financeira;
2. concorrência entre múltiplas instâncias;
3. idempotência persistente;
4. consistência entre saldo materializado e ledger;
5. processamento assíncrono e recuperação após falhas;
6. clareza das decisões técnicas.

O sistema deve continuar correto diante de mensagens duplicadas, fora de ordem e simultâneas, falhas de processo e indisponibilidade temporária do PostgreSQL ou SQS.

**Invariantes globais:** não duplicar créditos ou débitos, não perder eventos confirmados e nunca permitir saldo negativo.

# 3. Stack e limites técnicos

## Obrigatória

| Área | Tecnologia |
|---|---|
| Runtime, package manager e test runner | Bun 1.x |
| Linguagem | TypeScript strict |
| Framework | NestJS |
| Banco | PostgreSQL |
| Mensageria | AWS SQS via LocalStack ou MiniStack |
| Ambiente local | Docker Compose |
| Migrations | Versionadas e reversíveis |
| ORM | MikroORM (preferencial) ou TypeORM |

**Não usar Prisma nem outro ORM fora das opções aceitas.**

Sugestão de dependência para dinheiro: `decimal.js`. O uso de `number` para dinheiro é proibido. Identificadores, contadores, versões, timestamps e métricas podem usar tipos numéricos apropriados quando não representarem valores monetários.

# 4. Restrições invioláveis

1. Não usar `number`, `float` ou `double` para dinheiro.
2. Não usar cache em memória como garantia de idempotência.
3. Não confiar apenas no SQS FIFO para consistência.
4. Não publicar eventos antes do commit da transação financeira.
5. Não sobrescrever nem excluir lançamentos do ledger.
6. Não usar lock global compartilhado por todas as wallets.
7. Não executar `read → calculate → update` sem controle de concorrência.
8. A solução deve funcionar com múltiplas instâncias.
9. Unicidade, imutabilidade e não-negatividade precisam de garantias no schema do banco, não apenas no código.

# 5. Modelo de domínio

## 5.1 Money

Value Object imutável, baseado em decimal exato.

Contrato:

```ts
interface MoneyProps {
  amount: string;   // exemplo: "25.00"
  currency: string; // ISO-4217
}
```

Comportamentos esperados:

- `from(props)` e `zero(currency)`;
- `add`, `subtract`, `negate`;
- `isZero`, `isPositive`, `isNegative`;
- `isLessThan`, `equals`;
- `toJSON`, `toString`;
- validar que as moedas são iguais antes de operar.

Regras:

- entrada e serialização sempre como string decimal com escala fixa de duas casas;
- rejeitar `NaN`, `Infinity`, notação científica, string vazia, mais de duas casas e valores negativos quando o contrato não permitir;
- operações entre moedas diferentes geram erro de domínio;
- o modelo deve continuar preparado para múltiplas moedas, embora seja permitido operar apenas com BRL no escopo;
- persistir valor com tipo exato no PostgreSQL, por exemplo `NUMERIC`, e reidratar como `Money`.

## 5.2 Wallet — Aggregate Root

Uma wallet pertence a um `playerId` e tem uma moeda.

Invariantes:

- no máximo uma wallet por `playerId + currency`;
- saldo nunca negativo;
- toda alteração de saldo tem lançamento correspondente no ledger, na mesma transação SQL;
- operações concorrentes não causam lost update;
- moeda da operação deve ser igual à moeda da wallet;
- `version` inicia em 1 e incrementa somente quando o saldo muda.

A estratégia de concorrência pode ser pessimistic locking, optimistic locking com retry limitado, update atômico condicionado ou combinação. Justificar em `ARCHITECTURE.md`.

## 5.3 WagerTransaction

Tipos:

```ts
enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}
```

Regras:

- transações nascem em `PENDING`;
- `PROCESSED`, `REJECTED` e `FAILED` são estados terminais;
- transições inválidas devem lançar erro de estado;
- `OPENING` é interno e não pode ser submetido pela API nem pela fila;
- a mesma `Idempotency-Key` com payload diferente é conflito, não replay;
- armazenar referência externa e referência interna resolvida quando aplicável;
- registrar failure code estável e legível por máquina em rejeições/falhas.

## 5.4 WalletLedgerEntry

Registro imutável, sem métodos de transição.

Campos essenciais:

- id;
- walletId;
- transactionId;
- direction (`DEBIT` ou `CREDIT`);
- money;
- balanceBefore;
- balanceAfter;
- createdAt.

A factory deve validar a aritmética:

- `DEBIT`: `balanceBefore - money = balanceAfter`;
- `CREDIT`: `balanceBefore + money = balanceAfter`.

Regras:

- no máximo um lançamento por transação e wallet;
- `LOSS` não gera lançamento;
- transação rejeitada não gera lançamento;
- não apagar ou editar lançamentos;
- double-entry bookkeeping é diferencial opcional, não requisito.

## 5.5 Inbox e Outbox

Inbox:

- deduplicação persistente por `(consumerName, messageId)`;
- guardar hash do payload e timestamps;
- marcar processada dentro da transação que aplica os efeitos.

Outbox:

- guardar eventos de integração na mesma transação SQL da operação financeira;
- publicar depois do commit;
- suportar vários publishers concorrentes;
- armazenar tentativas, próximo retry e timestamp de publicação;
- permitir recuperação após crash.

A alteração financeira, ledger, inbox (quando entrada SQS) e outbox devem ser atômicos: tudo confirma junto ou nada confirma.

# 6. Regras de negócio

| Operação | Efeito no saldo | Ledger | Regra principal |
|---|---|---|---|
| `BET` | Débito | Um `DEBIT` | Rejeitar saldo insuficiente |
| `WIN` | Crédito | Um `CREDIT` | Pode referenciar BET da mesma rodada |
| `LOSS` | Nenhum | Nenhum | Registrar resultado |
| `REFUND` | Crédito | Um `CREDIT` | Reverte BET processada uma única vez |
| `ROLLBACK` | Inverso da referência | Um lançamento invertido | Reverte BET, WIN ou REFUND processada uma única vez |

Regras adicionais:

1. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.
2. Resolver referência por `(providerId, referenceExternalTransactionId)`.
3. Referência deve pertencer ao mesmo provider, player, wallet, moeda e rodada.
4. `REFUND` só pode referenciar `BET`.
5. `ROLLBACK` pode referenciar `BET`, `WIN` ou `REFUND`.
6. Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.
7. Valor de REFUND/ROLLBACK deve ser exatamente igual ao valor da referência. Reversão parcial não faz parte do escopo.
8. `REJECTED` não altera saldo nem gera ledger.
9. Repetição de operação já processada retorna o resultado original, incluindo o saldo observado naquele momento.
10. Reversão que produziria saldo negativo deve ser rejeitada explicitamente, com failure code diferente de saldo insuficiente de BET.
11. Referência ainda não encontrada gera `PENDING_REFERENCE`, não rejeição imediata.
12. Transações pendentes por referência devem ser reprocessadas por worker com backoff exponencial.
13. Definir e documentar limite de tentativas ou TTL. Ao esgotar, rejeitar com código que identifique referência inexistente e publicar evento correspondente.

Toda rejeição precisa de `failureCode` estável, legível por máquina e documentado.

# 7. Concorrência

A unidade de concorrência é `walletId`.

A solução precisa funcionar quando:

- duas apostas disputam o mesmo saldo;
- múltiplos workers recebem operações da mesma wallet;
- wallets diferentes são processadas em paralelo;
- três ou mais instâncias rodam simultaneamente.

SQS FIFO e suas opções de ordenação/deduplicação são otimizações; o PostgreSQL continua sendo a autoridade final.

## Cenário obrigatório

Saldo inicial: `100.00 BRL`. Duas apostas simultâneas de `80.00 BRL`.

Resultado:

- exatamente uma `PROCESSED`;
- outra `REJECTED` por saldo insuficiente;
- saldo final `20.00 BRL`;
- exatamente um débito no ledger;
- nenhum retry duplica o débito.

**Ponto de atenção:** o lock da wallet, isoladamente, não resolve concorrência de `Idempotency-Key`. Criar constraint única no banco e tratar corretamente conflitos de inserção. Também proteger a regra de reversão única com constraint/índice apropriado no banco.

# 8. API HTTP exigida

## Criar wallet

`POST /wallets`

Entrada de exemplo:

```json
{
  "playerId": "player-id",
  "initialBalance": {
    "amount": "1000.00",
    "currency": "BRL"
  }
}
```

Se o saldo inicial for maior que zero, criar `OPENING` interno e lançamento `CREDIT` no ledger na mesma transação SQL.

Wallet duplicada para o mesmo `playerId + currency` deve resultar em conflito.

## Consultas

```http
GET /wallets/:walletId
GET /wallets/:walletId/ledger?cursor=...&limit=50
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
```

O cursor do ledger deve ser estável e opaco.

## Submeter transação

`POST /wagering/transactions`

Header obrigatório:

```http
Idempotency-Key: provider-a:transaction-123
```

Exemplo de corpo:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "player-id",
  "walletId": "wallet-id",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}
```

Resposta processada ilustrativa:

```json
{
  "transactionId": "transaction-id",
  "status": "PROCESSED",
  "balance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "idempotentReplay": false
}
```

Idempotência:

- header `Idempotency-Key` obrigatório e fonte da verdade;
- default sugerido: `{providerId}:{externalTransactionId}`;
- `payloadHash` deve ser hash de JSON canônico, com chaves ordenadas, apenas dos campos de negócio;
- header e metadados de transporte não entram no hash;
- algoritmo e campos incluídos devem ser documentados;
- key + payload idêntico retorna a mesma resposta original, com `idempotentReplay: true`;
- key igual com payload diferente resulta em conflito.

A API precisa distinguir claramente:

- payload inválido;
- conflito de idempotência;
- rejeição por regra de negócio;
- aceito, mas pendente de processamento/referência;
- falha transitória de infraestrutura.

Não colapsar todas essas situações em um mesmo status HTTP.

## Reconciliação

`POST /wallets/:walletId/reconciliation`

Reconstruir o saldo a partir do ledger e comparar com o saldo materializado.

A resposta deve informar, no mínimo:

- walletId;
- storedBalance;
- calculatedBalance;
- difference;
- consistent;
- checkedEntries.

Divergências não devem ser corrigidas silenciosamente. Devem ser registradas em log, métrica e resposta.

## Health checks

```http
GET /health/live
GET /health/ready
```

- liveness: processo vivo;
- readiness: PostgreSQL e SQS alcançáveis;
- ambos sem autenticação.

# 9. SQS e processamento assíncrono

Filas:

```text
wager-transactions.fifo
wager-transactions-dlq.fifo
```

O consumidor deve:

- reutilizar exatamente o mesmo use case da entrada HTTP;
- deduplicar via inbox persistente por `(consumerName, messageId)`;
- fazer ACK somente depois do commit;
- erros de negócio terminais: ACK;
- erros transitórios: retry com backoff;
- erros permanentes: DLQ;
- respeitar limite de tentativas;
- em `SIGTERM`, concluir mensagens em andamento ou devolver a visibilidade;
- suportar redelivery sem duplicar efeitos.

# 10. Transactional Outbox e eventos

O evento deve ser persistido na outbox dentro do mesmo commit financeiro. Um worker separado publica eventos pendentes.

Cenário de recuperação obrigatório:

1. PostgreSQL confirma commit;
2. processo morre antes de publicar;
3. outra instância assume;
4. evento é publicado;
5. publicação duplicada continua segura para consumidores idempotentes.

Usar estratégia segura para múltiplos publishers, por exemplo seleção/claim concorrente com `FOR UPDATE SKIP LOCKED`, se adequada à implementação.

Eventos mínimos:

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | Qualquer transação aplicada, inclusive LOSS |
| `WagerTransactionRejected` | Rejeição por regra de negócio |
| `WalletBalanceChanged` | Somente quando o saldo muda |
| `WagerTransactionPendingReference` | Referência ainda não encontrada |

Cada evento deve ter envelope versionado com:

- `eventId`;
- `eventType`;
- `aggregateId`;
- `correlationId`;
- `causationId` opcional;
- `occurredAt`;
- `version`;
- `data`.

O `data` deve carregar valores monetários como `MoneyProps` (string decimal), nunca instâncias de classe `Money`.

# 11. Observabilidade

Obrigatório:

- logs estruturados em JSON;
- incluir `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` quando disponíveis;
- não registrar dados sensíveis nem payload financeiro completo;
- métricas para:
  - transações por status;
  - duplicatas detectadas;
  - retries;
  - mensagens em DLQ;
  - conflitos de lock;
  - outbox lag;
  - latência de processamento;
- health checks separados para liveness e readiness.

OpenTelemetry e dashboard são opcionais.

# 12. Testes obrigatórios

## Unidade

- operações e validações de Money (escala, arredondamento, entradas inválidas);
- invariantes da Wallet;
- regras BET, WIN, LOSS, REFUND e ROLLBACK;
- conflito de moeda;
- idempotency key com payload divergente.

## Integração

Usar PostgreSQL e LocalStack/MiniStack reais em containers para testar:

- migrations e constraints;
- atomicidade wallet + ledger + inbox + outbox;
- inbox e redelivery;
- publishers concorrentes na mesma outbox;
- retry e DLQ;
- recuperação após reinicialização.

## Concorrência real — não simular com mocks sequenciais

1. Mesma aposta enviada 50 vezes em paralelo: um único débito.
2. Apostas simultâneas disputando saldo: cenário 100/80/80.
3. Wallets distintas processadas em paralelo.
4. Três ou mais processos/instâncias simultâneos.
5. Worker morto depois do commit e antes do ACK.
6. Dois publishers sobre a mesma outbox.
7. ROLLBACK ou REFUND entregue antes da referência.
8. Reinício do serviço com consistência final comprovada.

Invariante final:

```text
wallet.balance == saldo reconstruído pelo ledger
```

Não substituir completamente PostgreSQL e SQS por mocks. Mocks podem ser usados em testes unitários, mas os cenários críticos devem usar integrações reais.

# 13. Avaliação e prioridades

| Área | Pontos |
|---|---:|
| Correção financeira | 20 |
| Concorrência | 20 |
| Idempotência | 15 |
| Mensageria e falhas | 15 |
| Modelagem e arquitetura | 10 |
| Testes | 10 |
| Observabilidade | 5 |
| Documentação | 5 |
| **Total** | **100** |

Os quatro primeiros itens somam 70 pontos. Portanto, priorizar correção financeira, concorrência, idempotência e mensageria antes de refinamentos cosméticos.

## Falhas eliminatórias

- `number` para dinheiro;
- saldo negativo causado por race condition;
- débito ou crédito duplicado;
- idempotência apenas em memória;
- solução correta somente com uma instância;
- publicação de evento antes do commit;
- ausência de ledger auditável;
- testes críticos substituídos integralmente por mocks.

## Diferenciais opcionais

Teste de carga, exposto como `bun run test:load`, com documentação de:

- ambiente e metodologia;
- throughput;
- p50/p95/p99;
- taxa de erro;
- conflitos de concorrência;
- outbox lag.

Não existe meta de RPS. Honestidade e qualidade da análise importam mais que números altos.

# 14. Autenticação: não gastar tempo desnecessário

Autenticação não vale pontos na avaliação.

É aceito não implementar, desde que:

- a decisão esteja documentada em `ARCHITECTURE.md`;
- o desenho futuro esteja descrito;
- exista ponto de extensão explícito no código (por exemplo `AuthGuard` no-op ou `ProviderIdentityPort`).

Se implementar, integrar um Identity Provider externo, como Keycloak ou Zitadel. Não criar autenticação artesanal nem tabela própria de usuários com hash de senha.

Health endpoints ficam abertos. Mensagens da fila são tratadas como canal interno confiável, mas os dados e a identidade do provider ainda precisam passar pelas validações de domínio.

# 15. Estrutura de projeto sugerida

A estrutura é uma proposta inicial, não uma obrigação. Ajuste se houver motivo técnico claro e documentado.

```text
jungle-wagering-processor/
├── src/
│   ├── domain/
│   │   ├── money/
│   │   ├── wallet/
│   │   ├── wagering/
│   │   ├── ledger/
│   │   ├── inbox/
│   │   └── outbox/
│   ├── application/
│   │   ├── wallets/
│   │   ├── wagering/
│   │   └── ports/
│   ├── infrastructure/
│   │   ├── persistence/
│   │   │   ├── entities/
│   │   │   ├── repositories/
│   │   │   └── migrations/
│   │   ├── messaging/
│   │   │   ├── sqs/
│   │   │   ├── inbox/
│   │   │   └── outbox/
│   │   ├── workers/
│   │   └── observability/
│   ├── presentation/
│   │   ├── http/
│   │   │   ├── wallets/
│   │   │   ├── wagering/
│   │   │   └── health/
│   │   └── dto/
│   ├── shared/
│   │   ├── errors/
│   │   └── utils/
│   ├── app.module.ts
│   └── main.ts
├── test/
│   ├── unit/
│   ├── integration/
│   ├── concurrency/
│   └── e2e/
├── docker/
├── docker-compose.yml
├── ARCHITECTURE.md
├── README.md
├── CODEX_INSTRUCOES.md
├── CHALLENGE.md
├── package.json
└── bun.lock
```

# 16. Plano de implementação por fases

O Codex deve propor ajustes, mas não pular fases sem aprovação.

## Fase 0 — Inspeção e planejamento

- ler o desafio e este documento;
- verificar estado do repositório;
- propor arquitetura e estrutura;
- listar decisões e riscos;
- montar plano e critérios de aceite por fase.

**Saída:** plano aprovado antes de código.

## Fase 1 — Fundação do projeto

- inicializar Bun + NestJS + TypeScript strict;
- configurar scripts;
- configurar Docker Compose;
- subir PostgreSQL e LocalStack/MiniStack;
- configurar variáveis de ambiente e validação de configuração;
- criar health básico e documentação inicial.

**Aceite:** aplicação inicia localmente e dependências ficam disponíveis.

## Fase 2 — Domínio puro

- Money;
- Wallet;
- WagerTransaction;
- WalletLedgerEntry;
- enums, erros e failure codes;
- factories create/from/rehydrate;
- transições explícitas;
- testes unitários.

**Aceite:** regras de domínio testadas sem depender de banco, NestJS ou SQS.

## Fase 3 — Persistência e integridade

- entidades/mapeamentos do ORM;
- migrations reversíveis;
- constraints e índices;
- repositories;
- transações SQL;
- locking por wallet;
- constraints para idempotência e reversão única;
- proteção da imutabilidade do ledger no banco quando viável.

**Aceite:** banco garante invariantes críticas, não apenas o código.

## Fase 4 — Casos de uso e API

- criar wallet e OPENING;
- consultas de wallet e ledger;
- consulta de transações;
- submissão de transação;
- validação dos DTOs;
- mapeamento consistente de erros HTTP;
- idempotência persistente;
- hash canônico.

**Aceite:** fluxo HTTP funciona com PostgreSQL real e testes de integração.

## Fase 5 — Concorrência e reversões

- estratégia de locking implementada e documentada;
- BET, WIN, LOSS, REFUND e ROLLBACK;
- proteção contra saldo negativo;
- prevenção de reversão duplicada;
- referências ausentes;
- cenários paralelos e múltiplas instâncias.

**Aceite:** cenários obrigatórios de concorrência passam de forma reproduzível.

## Fase 6 — SQS, Inbox e Outbox

- criar filas e DLQ localmente;
- publicar/submeter mensagens;
- consumer reutiliza o mesmo use case;
- inbox transacional;
- ACK depois do commit;
- retry/backoff e DLQ;
- publisher de outbox concorrente;
- eventos versionados;
- shutdown gracioso.

**Aceite:** redelivery e crash recovery não duplicam efeitos nem perdem eventos confirmados.

## Fase 7 — Referências pendentes e reconciliação

- worker de `PENDING_REFERENCE`;
- backoff e limite/TTL;
- rejeição após esgotamento;
- endpoint de reconciliação;
- logs e métricas de divergência.

**Aceite:** operações fora de ordem são resolvidas ou encerradas de forma auditável.

## Fase 8 — Observabilidade e testes finais

- logs estruturados;
- métricas obrigatórias;
- health liveness/readiness;
- testes unitários, integração, concorrência e e2e;
- teste de reinício e recuperação.

**Aceite:** evidências dos requisitos críticos registradas.

## Fase 9 — Documentação e entrega

- README com instalação, configuração, execução e testes;
- ARCHITECTURE com decisões, trade-offs, limites e autenticação;
- comandos reproduzíveis;
- checklist final contra o desafio;
- revisão de código e remoção de sobras.

**Aceite:** outra pessoa consegue subir, testar e entender a solução seguindo a documentação.

# 17. Decisões técnicas que precisam ser justificadas

O Codex deve registrar as decisões no `ARCHITECTURE.md`, incluindo:

1. ORM escolhido e motivo.
2. Representação de Money no domínio e no PostgreSQL.
3. Estratégia de concorrência e escopo do lock.
4. Como impedir duas requisições concorrentes com a mesma Idempotency-Key.
5. Como garantir uma única reversão por tipo.
6. Como garantir que saldo e ledger mudem atomicamente.
7. Como a inbox participa da transação e quando o SQS recebe ACK.
8. Como a outbox evita perda de evento após commit.
9. Como múltiplos publishers fazem claim sem disputar a mesma linha.
10. Política de retry, backoff, limite e DLQ.
11. Política de `PENDING_REFERENCE`.
12. Mapeamento de erros de domínio para HTTP.
13. Estratégia de reconciliação.
14. Decisão sobre autenticação.
15. Limitações conhecidas e o que ficou fora do escopo.

# 18. Checklist de revisão final

Antes de declarar o desafio pronto, conferir item por item:

- [ ] Bun 1.x usado para instalar, executar e testar.
- [ ] TypeScript strict ativo.
- [ ] NestJS e PostgreSQL reais.
- [ ] LocalStack/MiniStack e SQS funcionando.
- [ ] Migrations versionadas e reversíveis.
- [ ] ORM permitido; Prisma ausente.
- [ ] Nenhum cálculo monetário com `number`.
- [ ] Money imutável e decimal exato.
- [ ] Wallet única por player + currency.
- [ ] Saldo nunca negativo, inclusive sob concorrência.
- [ ] Ledger imutável e auditável.
- [ ] OPENING e ledger inicial atômicos.
- [ ] Estados terminais protegidos.
- [ ] BET/WIN/LOSS/REFUND/ROLLBACK corretos.
- [ ] Referência e reversão única protegidas.
- [ ] Idempotência persistente e payloadHash canônico.
- [ ] Key igual + payload diferente gera conflito.
- [ ] 50 requisições paralelas não duplicam débito.
- [ ] Cenário 100/80/80 passa.
- [ ] Três ou mais instâncias testadas.
- [ ] Inbox persistente e ACK após commit.
- [ ] Outbox transacional e publisher concorrente.
- [ ] Crash após commit recupera evento.
- [ ] Retry, backoff e DLQ testados.
- [ ] PENDING_REFERENCE reprocessado.
- [ ] Reconciliação compara saldo e ledger.
- [ ] Logs e métricas obrigatórios implementados.
- [ ] Liveness e readiness separados.
- [ ] README e ARCHITECTURE completos.
- [ ] Testes críticos usam PostgreSQL/SQS reais, não apenas mocks.

# 19. Como o Codex deve colaborar comigo

- Explique termos técnicos quando forem relevantes para a decisão.
- Não presuma que eu quero apenas código pronto: ajude-me a compreender o raciocínio.
- Ao sugerir uma solução, explique por que ela atende ao requisito e quais alternativas existem.
- Prefira alterações pequenas, revisáveis e com testes.
- Não faça refatorações amplas sem necessidade.
- Não esconda warnings, limitações ou testes que falharam.
- Se um comando falhar, investigue a causa em vez de contornar silenciosamente.
- Ao terminar cada fase, entregue:
  1. resumo do que foi feito;
  2. arquivos criados/alterados;
  3. decisões tomadas;
  4. testes executados e resultados;
  5. requisitos atendidos;
  6. pendências e riscos;
  7. próximo passo proposto.
- Pare e aguarde minha autorização antes de iniciar a fase seguinte.

**Critério máximo de sucesso:** uma implementação correta, demonstrável e compreensível, não apenas um repositório grande que parece completo.
