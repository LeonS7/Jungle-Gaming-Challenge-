# Decisões de arquitetura

## Fundação

- **Runtime e gerenciador de pacotes:** Bun 1.x. O TypeScript é validado e compilado por `tsc`; Bun inicia o código compilado e executa os testes.
- **Framework HTTP:** NestJS. O domínio permanece independente do NestJS e de seus decorators.
- **ORM:** MikroORM 7.2.9 com driver PostgreSQL. No MikroORM 7, os decorators legados são importados de `@mikro-orm/decorators/legacy`; `ReflectMetadataProvider` é configurado explicitamente.
- **Banco e mensageria locais:** PostgreSQL e LocalStack SQS são definidos no Docker Compose. O hook do LocalStack cria a fila FIFO de entrada, sua DLQ e a fila FIFO de eventos publicados pela outbox.
- **DLQ local:** a fila move uma mensagem após cinco recebimentos. O consumidor aplica backoff exponencial até 60 segundos; o limite de redrive é configurado na fila.
- **Configuração:** os valores obrigatórios são lidos e validados antes da inicialização do NestJS.
- **Health checks:** liveness verifica se o processo responde; readiness confirma acesso ao PostgreSQL e à fila SQS configurada.

## Limites entre camadas

O domínio não importa NestJS, ORM, SQS nem tipos HTTP. As classes de persistência em `infrastructure/persistence/entities` são registros do MikroORM e não substituem as entidades do domínio. `ProcessWager` implementa BET, WIN com ou sem referência, LOSS, REFUND e ROLLBACK por meio de uma porta de persistência; os eventos de integração são definidos na camada Application e persistidos pelo adapter PostgreSQL.

A aplicação não inicia migrations automaticamente. A execução é explícita por `bun run db:migrate`; a última migration pode ser revertida localmente por `bun run db:migrate:down`.

## Dinheiro

- `Money` mantém valores com `decimal.js` e aceita strings decimais simples com até duas casas fracionárias. A serialização sempre produz duas casas.
- `Money` permite valores com sinal para operações internas. Os fluxos de entrada devem validar positividade ou não negatividade conforme a regra do caso de uso.
- As colunas monetárias usam `NUMERIC(30,2)`. O mapeamento MikroORM usa `DecimalType` no modo string; valores monetários não passam por `number`.
- A validação da moeda usa os códigos ISO-4217 suportados pelo runtime. Operações e ordenação exigem a mesma moeda; igualdade entre moedas diferentes retorna `false`.
- `Money` configura um construtor isolado de `Decimal` com precisão significativa máxima, porque suas operações são soma, subtração, negação e comparação.

## Modelo de domínio

- **Wallet:** `open` inicia a versão em 1, usa a moeda do `Money` inicial, aceita saldo zero e rejeita saldo negativo. `debit` e `credit` validam valor positivo e moeda; montam o lançamento antes de alterar o saldo. Débito insuficiente não modifica o agregado.
- **Transação:** criação comum inicia em `PENDING`; `OPENING` só pode ser criada pela factory interna `createOpening`. `PENDING` pode ir para `PENDING_REFERENCE`, `PROCESSED`, `REJECTED` ou `FAILED`. `PENDING_REFERENCE` pode terminar em `PROCESSED`, `REJECTED` ou `FAILED`. Estados terminais não podem avançar.
- **Ledger:** `WalletLedgerEntry.create` valida valor positivo, saldos não negativos, moeda e aritmética. A entidade é estruturalmente imutável. `rehydrate` preserva o registro armazenado e `isBalanced` permite detectar inconsistências.
- **Efeitos de negócio:** `BET` debita; `WIN` e `REFUND` creditam; `ROLLBACK` aplica a direção inversa de uma `BET`, `WIN` ou `REFUND` processada; `LOSS` não gera lançamento. Referências de reversão precisam ser processadas e corresponder ao provedor, jogador, carteira, rodada, ID externo, valor e moeda.
- **Referências pendentes:** `REFUND` e `ROLLBACK` exigem referência externa. `WIN` pode recebê-la. Se ela não existir ou ainda estiver em processamento, a transação passa a `PENDING_REFERENCE`; não há movimento financeiro ou lançamento. Uma referência existente que viole as regras do domínio produz rejeição `INVALID_REFERENCE`. A migration adiciona prazo e metadados de retry duráveis, que são removidos quando a transação termina.
- **Códigos de falha:** são strings em maiúsculas com formato legível por máquina. O catálogo definitivo pertence aos casos de uso para que os códigos retornados pela API sejam estáveis.

## Persistência PostgreSQL

- A migration versionada `Migration20261113000000_CreateWageringSchema` cria `wallets`, `wager_transactions` e `wallet_ledger_entries`. `Migration20261113010000_AddWagerResultSnapshot` adiciona o saldo e a moeda usados na repetição idempotente. `Migration20261113020000_StrengthenWagerResultSnapshot` exige que ambos os campos do snapshot estejam juntos ou ausentes. `Migration20261113030000_AddTransactionalOutbox` cria a outbox. `Migration20261113040000_AddInboxMessages` cria a inbox; todas têm reversão e reaplicação verificadas.
- IDs persistidos usam `UUID`; dinheiro usa `NUMERIC(30,2)`, moeda usa `CHAR(3)` e datas usam `TIMESTAMPTZ`.
- A Wallet tem unicidade por `(player_id, currency)`, saldo com constraint não negativa e versão inicial igual a 1. Um gatilho exige incremento unitário de versão quando o saldo muda e impede alterações de identidade.
- Transações têm unicidade global da `idempotency_key`, conforme aprovado, e unicidade adicional por `(provider_id, external_transaction_id)`. Uma referência resolvida é protegida por chave estrangeira composta para manter provedor, ID externo, jogador, carteira, rodada e moeda consistentes.
- O banco valida tipos, valores positivos, campos obrigatórios, timestamps e transições de estado. Um índice único parcial permite no máximo uma reversão processada por `(reference_transaction_id, kind)`; uma reversão e um rollback são tipos diferentes.
- O ledger tem uma única entrada por `(wallet_id, transaction_id)`, valida a aritmética em constraint e rejeita `UPDATE`, `DELETE` e `TRUNCATE` por gatilhos. Outro gatilho impede lançamento para `LOSS`, `REJECTED` e `FAILED`.
- `outbox_messages` referencia a transação financeira, mantém evento e número de sequência únicos por transação, valida a correspondência entre colunas e envelope JSON e tem índice parcial para mensagens ainda não publicadas. Gatilhos impedem editar o conteúdo, remover mensagens, truncar a tabela, diminuir tentativas ou reabrir uma mensagem publicada; metadados de tentativa e publicação permanecem atualizáveis.
- `inbox_messages` usa chave primária `(consumer_name, message_id)`, valida SHA-256 hexadecimal e preserva o hash e o horário de recebimento. Gatilhos impedem alterar a identidade, remover/truncar mensagens ou reabrir uma mensagem processada; o único avanço permitido é preencher `processed_at`.
- A migration usa funções de gatilho por tabela e constraints locais; não cria locks globais. `FOR KEY SHARE` no gatilho do ledger protege a leitura da transação referenciada durante a validação do lançamento.

## BET, WIN, LOSS, REFUND e ROLLBACK: concorrência, idempotência e atomicidade

- `ProcessWager` é um caso de uso da camada Application e depende da porta `WagerPersistencePort`. O domínio continua sem dependência de NestJS, MikroORM, PostgreSQL ou SQS.
- A persistência abre uma transação PostgreSQL e consulta primeiro a chave de idempotência. Se ainda não houver resultado, bloqueia a linha da Wallet selecionada com `SELECT ... FOR UPDATE` e consulta a chave novamente. Esse bloqueio é por carteira, portanto operações em carteiras diferentes podem avançar em paralelo.
- As consultas SQL do adapter recebem explicitamente o contexto transacional do MikroORM. Sem isso, chamadas pela conexão SQL poderiam usar outra conexão e efetuar commit fora da transação de `EntityManager`.
- Para `BET`, `WIN`, `REFUND` e `ROLLBACK` processados, inserir a transação pendente, resolver e validar a referência quando necessária, atualizar o saldo com guarda de versão, inserir o lançamento e marcar a transação como processada com seu saldo final ocorre no mesmo commit. Uma falha em qualquer etapa reverte o conjunto.
- `REFUND` credita uma `BET` processada; `ROLLBACK` escolhe `CREDIT` para reverter `BET` e `DEBIT` para reverter `WIN` ou `REFUND`. Um índice único parcial do PostgreSQL permite no máximo uma reversão processada por `(reference_transaction_id, kind)`, além da verificação explícita no caso de uso. O bloqueio da carteira serializa concorrentes da mesma carteira; a constraint continua sendo a defesa final no banco.
- Se uma referência estiver ausente ou em estado `PENDING`/`PENDING_REFERENCE`, o caso de uso grava `PENDING_REFERENCE`, seu prazo de 24 horas e `WagerTransactionPendingReference` na outbox dentro da transação PostgreSQL. Nenhum saldo ou ledger é alterado. Repetições com a mesma chave e hash retornam `PENDING_REFERENCE` sem duplicar evento.
- O `PendingReferenceWorker` consulta linhas vencidas para tentativa com `FOR UPDATE SKIP LOCKED`; o claim, a busca da referência, a aplicação financeira e os eventos ficam na mesma transação PostgreSQL. Três ou mais réplicas podem executar esse worker: o lock de linha distribui os registros, e o lock da carteira serializa saldo e reversões. Falhas antes do commit liberam o registro para nova tentativa.
- A política aprovada usa atraso inicial de 1 segundo, dobra a cada tentativa até o limite de 300 segundos e expira em 24 horas. O próximo horário nunca ultrapassa `reference_expires_at`. Depois do prazo, a operação termina como `REJECTED/REFERENCE_EXPIRED`; uma referência que chegue depois desse corte não reabre a transação. O evento de pendência ocupa a sequência 1; o resultado final ocupa a sequência 2; uma mudança de saldo ocupa a sequência 3.
- Para uma `LOSS`, o bloqueio da carteira ordena a operação em relação a outros movimentos daquela carteira. O caso de uso registra a transação como processada com o saldo observado na mesma transação PostgreSQL, sem atualizar a carteira, avançar sua versão ou inserir lançamento no ledger.
- `WagerTransactionProcessed` é enfileirado para toda transação aplicada, inclusive `LOSS`; `WagerTransactionRejected` é enfileirado para uma rejeição de negócio; `WagerTransactionPendingReference` é enfileirado quando a referência ainda não pode ser resolvida. `WalletBalanceChanged` só é enfileirado quando existe lançamento e alteração de saldo. Uma abertura positiva de carteira também grava `WagerTransactionProcessed` e `WalletBalanceChanged`; uma abertura de saldo zero não cria transação nem evento.
- Cada evento usa um envelope JSON com versão, ID, agregado, correlação, data ISO-8601 e dados monetários serializados como strings. O ID da transação é usado como `correlationId`; eventos da transação usam a transação como agregado e eventos de saldo usam a carteira. `sequence_number` mantém o evento da transação antes do evento de alteração de saldo.
- A linha de outbox é inserida pela mesma sessão MikroORM e pelo mesmo contexto SQL da transação financeira. Se a inserção da outbox falhar, PostgreSQL reverte carteira, ledger, transação e qualquer evento daquela operação. O publisher lê somente linhas cujo commit já terminou.
- Para saldo insuficiente, a transação termina como rejeitada e armazena o saldo observado. A carteira e o ledger não mudam. A repetição idempotente de uma rejeição também retorna o saldo daquele momento, mesmo se o saldo atual tiver mudado depois.
- A chave de idempotência tem unicidade global no PostgreSQL. Colisões entre carteiras distintas são resolvidas pela constraint do banco; após rollback, o caso de uso carrega o resultado persistido e compara o hash dos dados recebidos.
- Testes com PostgreSQL real cobrem chamadas concorrentes idênticas, duas apostas disputando saldo, corrida da chave global entre carteiras, reversões concorrentes e três clientes PostgreSQL independentes tentando a mesma reversão, referências inválidas e pendentes, eventos, abertura de carteira, imutabilidade da outbox, falha induzida no ledger e na outbox com rollback financeiro e reversão/reaplicação das migrations. Três clientes independentes não constituem um ensaio com três processos da aplicação.

Esses mecanismos são compartilhados entre instâncias porque estado e arbitragem ficam no PostgreSQL; ainda não foi executado ensaio ponta a ponta com três processos da aplicação. A inbox protege a entrada e o publisher da outbox encaminha eventos confirmados ao SQS com lease e retry persistidos.

## Reconciliação de carteira

- `POST /wallets/:walletId/reconciliation` lê o saldo materializado e calcula `SUM(CREDIT) - SUM(DEBIT)` sobre o ledger na mesma instrução SQL. As colunas são `NUMERIC`; a diferença é calculada com `Money`, sem ponto flutuante.
- A resposta informa `storedBalance`, `calculatedBalance`, `difference` (saldo materializado menos saldo reconstituído), `consistent` e `checkedEntries`. Não há reparo automático: a divergência permanece disponível para investigação.
- Divergências geram log estruturado com ID da carteira e quantidade de lançamentos, sem incluir valores financeiros, e incrementam `wallet_reconciliation_divergences_total`. `GET /metrics` expõe esse contador no formato Prometheus.
- O contador está em memória por processo somente como métrica observacional, nunca como controle de idempotência ou de fluxo financeiro. Ele zera após reinício; em ambiente com várias réplicas, o coletor deve consultar cada processo e agregar as séries.
- Os testes HTTP usam PostgreSQL real, criam uma divergência deliberada de fixture e verificam saldos em strings, diferença, quantidade de lançamentos e incremento da métrica. A fixture altera somente o saldo materializado do schema descartável do teste.

## Entrada assíncrona por SQS e inbox

- `WagerSqsConsumer` resolve as URLs das filas configuradas e faz long polling FIFO com uma mensagem por vez. Cada processo trabalha sequencialmente; grupos de mensagens e processos diferentes podem avançar em paralelo, e a linha da carteira continua sendo o ponto de serialização financeira.
- `parseWagerQueueMessage` valida `messageId`, `type`, `occurredAt` e o objeto `data`; em seguida delega os campos do negócio ao parser de comando da Application, também usado pelo DTO HTTP, e calcula um SHA-256 do corpo original para a identidade da inbox. A chave `messageId` do envelope é usada como identidade estável entre redeliveries.
- `ProcessWager.executeFromInbox` registra `(consumerName, messageId)` com `INSERT ... ON CONFLICT` dentro da mesma transação PostgreSQL usada para idempotência, lock da carteira, saldo, ledger e outbox. O hash é comparado ao receber uma chave existente; conteúdo diferente é conflito permanente. A chave única faz instâncias concorrentes aguardarem o resultado transacional do primeiro consumidor.
- Uma mensagem nova só recebe `processed_at` no mesmo commit do resultado financeiro ou de uma rejeição de negócio. A repetição de mensagem já processada não entra no fluxo financeiro novamente. Se o processamento falha antes do commit, inbox e efeitos financeiros são revertidos em conjunto.
- O consumidor só envia `DeleteMessage` depois do retorno após commit. Um heartbeat renova a visibilidade a cada 15 segundos enquanto o processamento está ativo. Erros de negócio terminais são registrados como inbox concluída antes do ack; erros operacionais ficam na fila com backoff exponencial limitado a 60 segundos e obedecem a redrive da DLQ. Conteúdo inválido vai para a DLQ antes de remover a mensagem original, usando o `MessageId` de origem para que conteúdos iguais de mensagens distintas não sejam suprimidos pela deduplicação FIFO.
- No encerramento do módulo, o long polling é abortado e o loop aguarda terminar a mensagem em andamento. A inbox não tem expurgo nesta fase: remover registros antigos faria redeliveries tardias perderem a proteção persistente.
- Os testes PostgreSQL verificam três clientes independentes recebendo o mesmo ID simultaneamente, uma única movimentação financeira, colisão de conteúdo, rollback conjunto quando a outbox falha e as constraints/imutabilidade da tabela. O teste de integração com LocalStack cria filas FIFO temporárias e verifica commit antes do ack, redelivery, retry após falha transitória, redrive automático após o limite de tentativas e envio de payload inválido à DLQ.

O consumidor de entrada e o publisher da outbox estão implementados; a Fase 6 cobre os dois fluxos com PostgreSQL e LocalStack.

## Publisher da outbox

- A saída usa uma fila FIFO separada, `wager-events.fifo`, pois seu envelope de evento não corresponde ao contrato da fila de entrada `wager-transactions.fifo`. A readiness exige acesso às duas filas e à DLQ de entrada.
- Cada publisher seleciona linhas elegíveis em transação curta com `FOR UPDATE SKIP LOCKED`, grava um `lock_token` exclusivo e `locked_until`, e confirma o claim antes de acessar o SQS. O lease permite que outra instância recupere o evento depois que o processo morre.
- A consulta só reclama o menor `sequence_number` ainda não publicado de cada transação. O `transaction_id` é usado como `MessageGroupId`, mantendo a ordem dos eventos da mesma transação na fila FIFO. `eventId` é o `MessageDeduplicationId` estável.
- Depois do envio, a linha recebe `published_at` e tem o lease removido, desde que o token ainda pertença ao publisher. Se o SQS falhar, o número de tentativas e `next_attempt_at` são atualizados com backoff exponencial limitado a 60 segundos; o payload original nunca muda nem é apagado.
- Se o processo cair depois do envio e antes do `published_at`, o lease vence e outra instância envia o mesmo `eventId`. A entrega é *at-least-once*; a deduplicação FIFO reduz duplicatas dentro da janela do SQS, mas consumidores também precisam persistir idempotência.
- Falhas de publicação não são removidas para uma DLQ: a outbox PostgreSQL retém os eventos e continua tentando. A fila separada de DLQ é usada pelo consumidor de mensagens de entrada inválidas.
- Testes PostgreSQL e LocalStack verificam dois publishers concorrentes, a ordem dos eventos, deduplicação após falha ao confirmar o envio, recuperação de lease vencido e retry após indisponibilidade da fila.

## Entrada HTTP de wagering

- `WageringController` expõe `POST /wagering/transactions` e chama `ProcessWager`; não duplica regras financeiras. O schema opcional de `AppModule.register` permite subir a mesma composição contra schemas PostgreSQL isolados nos testes HTTP.
- O DTO valida o objeto, rejeita campos desconhecidos, exige `Idempotency-Key`, UUID válido para `walletId` e dinheiro como string positiva com duas casas. A precisão inteira aceita respeita `NUMERIC(30,2)`.
- `hashWagerPayload` calcula SHA-256 sobre JSON com ordem de chaves fixa: `externalTransactionId`, `gameId`, `kind`, `money`, `playerId`, `providerId`, referência externa quando presente, `roundId` e `walletId`. Dentro de `money`, a ordem é `amount`, `currency`. A chave de idempotência e metadados de transporte são excluídos; o valor monetário é normalizado antes do hash. A referência entra no hash para impedir que uma mesma chave seja reutilizada apontando para outra transação.
- BET, WIN, LOSS, REFUND e ROLLBACK processados ou rejeitados usam HTTP 200 e mantêm `status`, `balance` e `idempotentReplay`. Referência ausente ou ainda pendente usa HTTP 202 e retorna `PENDING_REFERENCE` sem `balance`. Entrada inválida usa 400; colisões de idempotência e de transação externa usam 409; carteira inexistente ou de outro jogador usa 404; moeda divergente usa 422.
- Moeda diferente da moeda da carteira retorna 422 antes de inserir a transação, pois o vínculo composto do banco exige moeda consistente com a carteira.
- Indisponibilidade PostgreSQL reconhecida por SQLSTATE de conexão/rollback ou códigos de rede conhecidos é traduzida para 503. Falhas inesperadas recebem 500 sem expor detalhes financeiros.
- A autenticação não foi implementada porque não pontua na avaliação e o desafio permite deixar esse escopo de fora. O comentário junto à rota marca o ponto para anexar uma proteção respaldada por provedor de identidade externo; não há autenticação local artesanal. Essa rota permanece sem proteção até essa integração.
- Testes HTTP iniciam NestJS em porta local efêmera, usam schemas temporários PostgreSQL e cobrem submissões concorrentes, reversões com referência, WIN pendente, replay/conflito, validação, tipo não suportado, carteira ausente e rejeição por saldo insuficiente.

`Wallet.open` agora é usado pelo caso de uso `OpenWallet`. Os testes isolados de processamento de wagering também preparam dados de abertura diretamente como fixture de integração.

## Abertura de carteira

- `OpenWallet` cria a entidade `Wallet` e chama uma porta que persiste a abertura atomicamente. Para saldo inicial positivo, o caso de uso também cria a transação `OPENING` e o lançamento `CREDIT` de zero até o saldo inicial.
- O adapter insere primeiro a Wallet, depois a transação em `PENDING`, o ledger e, por fim, marca a transação como `PROCESSED` com o snapshot do saldo, tudo na mesma transação PostgreSQL. Falhas no ledger revertem todos esses registros.
- Saldos iniciais iguais a zero criam apenas a Wallet, pois não há movimento a registrar. O saldo inicial não incrementa a versão: a Wallet já nasce com esse valor e versão 1.
- Os identificadores da transação interna, da transação externa interna e da chave são UUIDs gerados pelo caso de uso. O provedor interno é `internal`; não é necessário reservar um prefixo nas chaves externas.
- `POST /wallets` valida dinheiro decimal como string e responde 409 para a constraint `wallets_player_currency_uq`. Testes HTTP reais cobrem abertura positiva, saldo zero, criação concorrente duplicada e rollback induzido no ledger.

## Consultas HTTP

- `GetWallet`, `GetWalletLedger` e `GetWagerTransaction` dependem de portas de leitura; adapters PostgreSQL fazem projeções SQL sem carregar entidades de escrita nem alterar estado financeiro.
- A carteira retorna `id`, `playerId`, `balance` serializado por `Money` e `version`. Consultas de transação omitem `idempotencyKey` e `payloadHash`, que são detalhes internos.
- O ledger é ordenado por `created_at DESC, id DESC`. O cursor é base64url com versão, carteira, timestamp PostgreSQL em microssegundos e ID do lançamento. O adapter usa comparação de tupla `(created_at, id)` e índice existente, sem `OFFSET`; o ID desempata timestamps iguais. O cursor é tratado como opaco pelo contrato HTTP, mas não é uma assinatura criptográfica.
- O limite padrão é 50 lançamentos e o máximo é 100. Cursor malformado ou de outra carteira responde 400; carteira ou transação inexistente responde 404; indisponibilidade reconhecida do PostgreSQL responde 503.
- Testes HTTP com PostgreSQL real verificam projeções monetárias como strings, busca por ID e identidade do provedor, paginação de múltiplas páginas, cursor/limite inválidos e recursos inexistentes.

## Verificação

- `bun run check`: verifica os tipos da aplicação e dos testes.
- `bun test`: executa a suíte; os testes de integração precisam do PostgreSQL local disponível.
- `bun run test:integration`: executa testes reais de migrations/constraints e dos casos de uso de wagering em schemas temporários isolados, incluindo concorrência, repetição idempotente e rollback.
- `bun run db:migrate` e `bun run db:migrate:down`: aplicam ou revertem a última migration no banco configurado.

## Referências do MikroORM

- [Migrations](https://mikro-orm.io/docs/migrations)
- [Tipos decimais](https://mikro-orm.io/docs/custom-types)
- [Uso de decorators](https://mikro-orm.io/docs/using-decorators)
