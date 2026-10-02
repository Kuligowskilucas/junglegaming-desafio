# Arquitetura

Este documento explica como o Distributed Wagering Processor garante correção financeira, idempotência e consistência com várias instâncias, e por que cada escolha foi feita.

**Como ler:**
- Cada decisão tem um identificador estável (**D1** a **D53**), citado também no README.
- As decisões trazem as opções avaliadas, os trade-offs e a evidência: o teste que prova a afirmação ou o número medido.
- Quando uma decisão responde a um requisito do enunciado do desafio, a referência vem como "(enunciado, seção N: requisito)", com o requisito descrito ao lado, para que o texto se sustente sozinho.

## Sumário

1. [Mapa de avaliação](#1-mapa-de-avaliação)
2. [Visão geral](#2-visão-geral)
3. [Stack e versões](#3-stack-e-versões)
4. [Estrutura e regra de dependência](#4-estrutura-e-regra-de-dependência)
5. [Fundação: emulador, filas, mapeamento, config, logs, health, migrations e testes](#5-fundação-emulador-filas-mapeamento-config-logs-health-migrations-e-testes) (D1–D8)
6. [Domínio](#6-domínio) (D9–D16)
7. [Persistência e API de wallets](#7-persistência-e-api-de-wallets) (D17–D23)
8. [Submissão de transações](#8-submissão-de-transações) (D24–D28)
9. [Consumer SQS](#9-consumer-sqs) (D29–D34)
10. [Publisher do outbox e worker de PENDING_REFERENCE](#10-publisher-do-outbox-e-worker-de-pending_reference) (D35–D41)
11. [Reconciliação, métricas e logs](#11-reconciliação-métricas-e-logs) (D42–D47)
12. [Múltiplas instâncias, falhas de processo e empacotamento](#12-múltiplas-instâncias-falhas-de-processo-e-empacotamento) (D48–D53)
13. [Autenticação](#13-autenticação)
14. [Limitações conhecidas](#14-limitações-conhecidas)

## 1. Mapa de avaliação

Para cada critério de avaliação do desafio, onde estão as decisões, o código principal e os testes que servem de evidência. Os caminhos de teste são relativos a `test/`. Todo teste de integração, de concorrência e multiprocesso termina conferindo, em todas as wallets do banco, que o saldo é igual ao reconstruído pelo ledger (`support/ledger-invariant.ts`).

| Critério (peso) | O que é observado | Decisões | Código principal | Testes |
|---|---|---|---|---|
| Correção financeira (20) | Money, saldo, ledger, reversões, reconciliação | D9, D11, D12, D17, D18, D42 | `src/domain/shared/money.ts`, `src/domain/wallet/wallet.ts`, `src/domain/wallet/wallet-ledger-entry.ts`, `src/domain/wagering/wager-settlement.ts`, migrations `…000003` e `…000004`, `src/application/wallet/reconcile-wallet.ts` | `unit/domain/shared/money.test.ts`, `unit/domain/wallet/wallet.test.ts` (propriedade com 1000 movimentos), `unit/domain/wagering/wager-settlement.test.ts`, `integration/database/constraints.test.ts`, `integration/database/ledger-coherence.test.ts`, `integration/http/reconciliation.test.ts`, `integration/application/reconcile-wallet.test.ts` |
| Concorrência (20) | Lost updates, hot wallet, múltiplas instâncias, locks | D24, D25, D26, D32, D36, D38, D48 | `src/application/wagering/submit-wager-transaction.ts`, `src/application/wagering/settle-and-record.ts`, `src/infrastructure/database/repositories/mikro-orm-wallet.repository.ts` (`FOR UPDATE`), `mikro-orm-outbox.repository.ts` (`SKIP LOCKED`) | `concurrency/wagering.test.ts`, `multiprocess/http-instances.test.ts`, `multiprocess/messaging-instances.test.ts`, `integration/workers/pending-reference-worker.test.ts` |
| Idempotência (15) | Dedup persistente, replay, payload conflitante | D13, D19, D25, D27, D29 | `src/domain/wagering/wager-payload.ts`, `src/application/messaging/handle-wager-transaction-requested.ts`, unique `wager_transactions_idempotency_key`, PK do inbox | `integration/application/submit-wager-transaction.test.ts` (caminho da unique, determinístico), `integration/http/wagering.test.ts`, `integration/sqs/wager-transaction-consumer.test.ts`, mesma aposta 50× em `concurrency/` e em `multiprocess/` |
| Mensageria e falhas (15) | Inbox, outbox, retry, DLQ, crash recovery, shutdown | D29–D41, D49, D50 | `src/interfaces/sqs/wager-transaction.consumer.ts`, `src/interfaces/workers/`, `src/application/messaging/` | `integration/sqs/wager-transaction-consumer.test.ts`, `integration/sqs/consumer-shutdown.test.ts`, `integration/workers/outbox-publisher.test.ts`, `multiprocess/process-failures.test.ts`, `multiprocess/restart-consistency.test.ts` |
| Modelagem e arquitetura (10) | Invariantes encapsuladas em classes, boundaries, portas, simplicidade | D3, D9–D16, D21, seção 4 | `src/domain/`, `src/application/ports/` | `unit/architecture/dependency-rule.test.ts`, `unit/domain/` |
| Testes (10) | Integração real, races, determinismo, cobertura de falhas | D8, D25, D34, D41, D42, D48–D50 | `test/support/` (lock entre arquivos, reset do banco, processos reais, proxy de falhas do SQS) | Toda a pasta `test/`. Provas determinísticas de corridas: caminho da unique (D25), snapshot da reconciliação (D42), janela entre commit e ack (D49) |
| Observabilidade (5) | Logs, métricas, health checks, diagnóstico | D5, D6, D43–D47 | `src/infrastructure/observability/`, `src/interfaces/http/health/`, `src/interfaces/http/metrics/` | `integration/observability/metrics.test.ts`, `integration/observability/logs.test.ts`, `integration/health.test.ts`, `unit/infrastructure/log-serializers.test.ts` |
| Documentação (5) | README com setup e comandos; decisões, trade-offs e limitações | Este documento | `README.md`, `ARCHITECTURE.md` | — |

**Falhas eliminatórias e onde cada uma é impedida:**

| Falha | Como o sistema a impede | Evidência |
|---|---|---|
| `number` para dinheiro | `Money` em `bigint` de centavos e `numeric(19,2)` no banco; a entrada é string com exatamente 2 casas (D9, D18) | `unit/domain/shared/money.test.ts` |
| Saldo negativo causado por race | Lock da wallet antes de ler o saldo (D24), `canDebit` no domínio (D11) e `CHECK` no banco (D17) | `concurrency/wagering.test.ts` (duas apostas de 80.00 sobre 100.00), `multiprocess/http-instances.test.ts` |
| Débito ou crédito duplicado | Unique de idempotência, um lançamento por transação e uma reversão por referência no banco (D17, D25) | Mesma aposta 50× (1 débito), REFUND × ROLLBACK em paralelo, `multiprocess/` |
| Idempotência apenas em memória | Uniques e inbox no Postgres (D19, D29); nenhuma deduplicação em memória | Reentregas e reinício em `multiprocess/restart-consistency.test.ts` |
| Correto só com uma instância | Toda garantia está no banco; testes com 3 processos reais (D48–D50) | `multiprocess/` |
| Evento publicado antes do commit | Eventos só entram no outbox, na mesma transação do efeito; o publisher lê o que já foi confirmado (D24, D35–D37) | `integration/workers/outbox-publisher.test.ts`, `multiprocess/messaging-instances.test.ts` |
| Ausência de ledger auditável | Ledger append-only, encadeado e coerente com o saldo por triggers (D11, D17), paginado por cursor estável (D22) | `integration/database/ledger-coherence.test.ts`, `integration/http/wallets.test.ts` |
| Testes que substituem PostgreSQL e SQS por mocks | Toda a suíte de integração usa Postgres e LocalStack reais (D8). O spy de D41 só embrulha o publisher real, e o proxy de D49 encaminha ao LocalStack real | `integration/`, `multiprocess/` |

## 2. Visão geral

**Componentes.** Cada instância roda a API HTTP, o consumer SQS, o publisher do outbox e o worker de PENDING_REFERENCE (D52). Todas compartilham o mesmo Postgres e as mesmas filas, e nenhuma guarda estado de negócio em memória.

```
     provedores (HTTP)                                  wager-transactions.fifo (SQS)
            │                                                        │
            ▼                                                        ▼
   WageringController                                 WagerTransactionConsumer
            │                                         (inbox na mesma transação, D29)
            └──────────────► SubmitWagerTransaction ◄────────────────┘
                                        │
                       SettleAndRecord: lock da wallet + settlement (D24, D38)
                                        │   uma transação SQL
          ┌─────────────────────────────┼──────────────────────────────┐
          ▼                             ▼                              ▼
  wager_transactions          wallets + wallet_ledger_entries     outbox_messages
          ▲                                                            │
  PendingReferenceWorker (D38)                       OutboxPublisherWorker (D36)
                                                                       │
                                                                       ▼
                                                           wager-events.fifo (SQS)
```

**O caminho de uma transação:**
1. **Fora da transação SQL:** valida o payload e calcula o `payloadHash` (D13); uma busca de idempotência sem lock responde replays sem disputar a wallet (D24).
2. **Dentro da transação SQL**, numa ordem fixa (D24, D29, D38):
   1. inbox, quando a entrada é SQS;
   2. `SELECT … FOR UPDATE` na wallet;
   3. revalida a idempotência sob o lock;
   4. settlement de domínio (D12);
   5. grava transação, lançamento, wallet e eventos no outbox;
   6. reagenda as dependentes que esperavam por esta transação.
3. **COMMIT:** os triggers deferidos conferem saldo × ledger × transação (D17).
4. **Depois do COMMIT:** resposta HTTP ou ack da mensagem (D29), publicação dos eventos pelo publisher (D36), métricas e logs (D43, D47).

**Invariantes e onde vivem:**

| Invariante | No domínio | No banco | Prova |
|---|---|---|---|
| Dinheiro exato, 2 casas | `Money` em `bigint` (D9) | `numeric(19,2)` e `CHECK`s (D18) | `unit/domain/shared/money.test.ts` |
| Saldo nunca negativo | `canDebit` antes de `debit` (D11) | `wallets_balance_non_negative` (D17) | duas apostas de 80.00 sobre 100.00, em processo único e em 3 processos |
| Nenhum débito ou crédito duplicado | idempotência por chave e hash (D25) | uniques, um lançamento por transação, reversão única (D17) | mesma aposta 50×, REFUND × ROLLBACK, reinício (D50) |
| Saldo = ledger | `debit`/`credit` devolvem o lançamento (D11) | triggers deferidos de coerência (D17) | `integration/database/ledger-coherence.test.ts`, invariante depois de cada teste, reconciliação (D42) |
| Ledger imutável | `WalletLedgerEntry` congelado | trigger append-only (D17) | `integration/database/constraints.test.ts` |
| Idempotência persistente | `payloadHash` (D13) | `wager_transactions_idempotency_key`, PK do inbox (D19, D29) | `integration/application/submit-wager-transaction.test.ts`, testes do consumer |
| Nenhum evento antes do commit | eventos só como `OutboxMessage` | outbox na mesma transação, guard (D17) | testes do publisher, `multiprocess/messaging-instances.test.ts` |
| Concorrência por wallet, sem lock global | — | `SELECT … FOR UPDATE` na linha da wallet (D24) | 10 wallets × 30 apostas em paralelo |
| Correto com N instâncias | — | tudo acima | `multiprocess/` (D48–D50) |

## 3. Stack e versões

| Item | Versão | Observação |
|---|---|---|
| Bun | 1.4.2 | Runtime, gerenciador de pacotes e test runner; executa o TypeScript direto, sem build |
| NestJS | 12.1.2 (`platform-express`) | Pacotes publicados como ESM |
| MikroORM | 7.2.3 (`@mikro-orm/nestjs` 7.1.0) | Sem decorators (D3); o query builder Kysely embutido atende às consultas tipadas (D36, D42) |
| PostgreSQL | 18.6 (alpine) | |
| SQS | LocalStack 4.14.0; `@aws-sdk/client-sqs` 3.1145.0 | Ver D1 |
| TypeScript | 6.0.3 | Usado só para checar tipos (`tsc --noEmit`) |
| zod | 4.6.5 | Validação do env (D4), dos DTOs HTTP e do envelope SQS (Standard Schema) |
| pino / pino-http / nestjs-pino | 10.3.1 / 11.0.0 / 5.2.1 | Logs JSON (D5, D47) |
| prom-client | 15.1.3 | Métricas no formato do Prometheus (D43) |
| Imagem da aplicação | `oven/bun:1.4.2-alpine` | D51 |

Todas as dependências estão fixadas em versão exata, e o `bun.lock` é versionado.

### Decorators e metadata no Bun

O DI do NestJS descobre as dependências de um construtor lendo a metadata `design:paramtypes`, que o compilador emite quando `emitDecoratorMetadata` está ligado. A compatibilidade é garantida assim:

1. **O Bun lê o `tsconfig.json`** e, com `experimentalDecorators` e `emitDecoratorMetadata`, emite essa metadata ao transpilar. Não usamos `nest build` nem `@nestjs/cli`. Por isso o `tsconfig.json` também vai para a imagem (D51).
2. **`import "reflect-metadata"`** é a primeira linha de `src/main.ts`. Nos testes, entra pelo `preload` do `bunfig.toml`.
3. **O MikroORM não depende de decorators.** O mapeamento usa `defineEntity` (D3), então decorators e metadata ficam restritos ao Nest.
4. **`isolatedModules` + `verbatimModuleSyntax` + `emitDecoratorMetadata`:** o `tsc` acusa o erro TS1272 quando um tipo puro (interface) aparece numa assinatura decorada. É exatamente o caso em que a metadata sairia como `Object` e o DI quebraria em runtime. Uma classe injetada é sempre importada como valor (`import { X }`), nunca com `import type`.
5. **ESM em tudo** (`"type": "module"`). Import circular entre módulos é proibido: em ESM ele vira erro de TDZ, e não o `undefined` silencioso do CommonJS.
6. **Prova executável:** os testes de integração sobem o `AppModule` real dentro do `bun test`, com controllers, DI por tipo e MikroORM. Se a metadata não for emitida, eles falham.

**Por que TypeScript 6 e não 7:** o TS 7 (compilador nativo em Go) checa tipos mais rápido, mas ainda não tem API programática, de que parte do ecossistema (lint, plugins) depende. Ficamos no 6.0.3 por estabilidade. Como o TS 6 mudou o padrão de `types` para `[]`, o tsconfig declara `types: ["bun"]` explicitamente.

## 4. Estrutura e regra de dependência

```
src/
├── main.ts, app.factory.ts, app.module.ts   composition root da API
├── migrate.ts                               migrations no container (D51)
├── domain/             puro: sem @nestjs, @mikro-orm, @aws-sdk (seção 6)
│   ├── shared/         Money, erros de domínio, JSON canônico, backoff
│   ├── wallet/         Wallet, WalletLedgerEntry, LedgerDirection, WalletReconciliation
│   ├── wagering/       WagerTransaction, kind, status, FailureCode, payloadHash, settleWagerTransaction
│   ├── messaging/      InboxMessage, OutboxMessage
│   └── events/         IntegrationEvent e as 4 subclasses
├── application/        casos de uso e portas (abstract classes)
│   ├── ports/          repositórios, TransactionRunner, Clock, IdGenerator, EventPublisher
│   ├── wallet/         OpenWallet, GetWallet, ListWalletLedger, ReconcileWallet
│   ├── wagering/       SubmitWagerTransaction, SettleAndRecord, RetryPendingReferences, GetWagerTransaction
│   └── messaging/      HandleWagerTransactionRequested (inbox), PublishPendingEvents
├── infrastructure/     adaptadores de saída e serviços técnicos
│   ├── config/         AppConfig (env validado)
│   ├── database/       MikroORM, records, mappers, repositórios, migrations, health, sondas do /metrics
│   ├── messaging/      cliente SQS, gateway, publicação de eventos, health, sonda das filas
│   ├── observability/  logs, serializers, métricas
│   └── system/         relógio e ids
└── interfaces/         adaptadores de entrada
    ├── http/           controllers (wallets, wagering, health, metrics), erros RFC 9457, AuthGuard
    ├── sqs/            consumer: inbox, backoff, DLQ, shutdown
    ├── workers/        publisher do outbox e worker de PENDING_REFERENCE
    └── use-cases/      módulo Nest que liga os casos de uso compartilhados por HTTP e SQS
test/
├── unit/               domínio, arquitetura, config, serializers, helpers do consumer
├── integration/        Postgres e LocalStack reais
├── concurrency/        paralelismo real no HTTP
├── multiprocess/       processos reais da aplicação (D48)
└── support/            lock entre arquivos, reset do banco, clientes, processos, proxy de falhas
scripts/verify-replicas.ts   verificação das réplicas do compose (D53)
docker/                      init do Postgres (banco de testes) e das filas (D2)
Dockerfile, docker-compose.yml   imagem e réplicas (D51)
```

- A pasta de cima é a camada, e dentro dela vem o agregado. Há um único bounded context, e o caso de uso central escreve wallet, ledger, transação, inbox e outbox na mesma transação SQL. Separar por feature criaria imports cruzados o tempo todo. Com a camada no topo, a regra de dependência aparece no caminho do arquivo.
- **Regra:** `domain` não importa nada fora de si. `application` importa só `domain`. `infrastructure` e `interfaces` importam as duas. O teste de arquitetura (D16) varre os imports de `src/domain` e `src/application` e falha se a regra for violada.
- Módulos Nest só existem em `infrastructure/`, `interfaces/` e `app.module.ts`.

## 5. Fundação: emulador, filas, mapeamento, config, logs, health, migrations e testes

### D1. Emulador SQS: LocalStack 4.14.0 fixada

Desde 23/03/2026, o `localstack/localstack:latest` é uma imagem única que exige conta e `LOCALSTACK_AUTH_TOKEN`. A `4.14.0`, de 26/02/2026, é a última que roda sem token.

| Opção | Prós | Contras |
|---|---|---|
| LocalStack `latest` | Atualizada | Exige conta e token: quem avalia não consegue subir o projeto sem se cadastrar |
| **LocalStack `4.14.0` (escolhida)** | Sem token; emulação de SQS FIFO, deduplicação, visibilidade e redrive madura e amplamente usada | Congelada (repositório arquivado, sem patches); imagem de cerca de 1 GB |
| MiniStack 1.5.x (alternativa considerada) | MIT, sem conta, cerca de 110 MB, sobe em menos de 2 s; compatível com LocalStack (porta 4566, `ready.d`, `awslocal`) | Projeto jovem, com fidelidade menos comprovada justamente em FIFO, redrive e visibilidade, das quais os testes de DLQ e redelivery (D34) dependem |

O critério foi a fidelidade do comportamento de FIFO e redrive. Para manter a troca barata, o serviço no Compose se chama `sqs` (e não `localstack`), e scripts e healthcheck usam só `awslocal`, presente nas duas imagens. **Trocar de emulador é mudar a linha `image:`.**

`SQS_ENDPOINT_STRATEGY=path` gera URLs de fila no formato `.../queue/<região>/<conta>/<nome>`, sem subdomínio por região. A aplicação não depende do host dessas URLs: com `endpoint` configurado, o SDK v3 envia toda requisição ao endpoint configurado e ignora o host da `QueueUrl`.

### D2. Criação das filas: script `ready.d` no container do emulador

O script `docker/sqs/init/ready.d/01-create-queues.sh` roda quando o LocalStack fica pronto, de novo a cada start, porque o emulador não persiste estado. O healthcheck do serviço consulta a fila de eventos, que é a última criada (`awslocal sqs get-queue-url`), então `docker compose up --wait` só retorna depois que todas as filas existem.

| Fila | Atributos |
|---|---|
| `wager-transactions-dlq.fifo` | `FifoQueue=true`, retenção de 14 dias |
| `wager-transactions.fifo` | `FifoQueue=true`, `ContentBasedDeduplication=false` (o produtor envia `MessageDeduplicationId=messageId`), `VisibilityTimeout=30`, `ReceiveMessageWaitTimeSeconds=20` (long polling), `RedrivePolicy={deadLetterTargetArn: DLQ, maxReceiveCount: SQS_MAX_RECEIVE_COUNT}` (padrão 10, D31) |
| `wager-events.fifo` | `FifoQueue=true`, `ContentBasedDeduplication=false` (o publisher envia `MessageDeduplicationId=eventId`), retenção de 14 dias, sem DLQ própria (D35) |

Alternativas descartadas:
- **Criar na subida da aplicação:** em produção exigiria permissão de `CreateQueue` para a app e geraria corrida entre instâncias. Provisionamento é responsabilidade da infra (IaC), não do runtime.
- **Container `aws-cli` one-shot:** mais uma imagem e um serviço, sem ganho.
- **Script manual:** um passo a mais no setup.

A deduplicação e a ordenação do FIFO são **otimização**. As garantias de idempotência e consistência ficam no banco (D17, D25, D29).

### D3. Mapeamento MikroORM: records de persistência + mappers

| Opção | Resultado |
|---|---|
| Decorators nas classes de domínio | **Proibido:** o domínio não importa MikroORM |
| A. `EntitySchema` mapeando as classes de domínio direto | Descartada: o ORM hidrata via `Object.create` e **ignora o `rehydrate`**, que o enunciado exige (seção 6.0: a reidratação a partir do banco usa a factory `rehydrate`); exige mapear campos privados (`_balance`) por nome; Money com Decimal precisaria de Embeddable e custom Type; o `version` gerido pelo ORM conflita com o do domínio, que só sobe quando o saldo muda |
| **B. Records com `defineEntity` + mappers (escolhida)** | Domínio 100% puro; o mapper chama `Wallet.rehydrate(...)`; colunas monetárias `numeric(19,2)` chegam do driver `pg` como string e viram `Money.from`, sem passar por `number`; tipos inferidos sem reflect-metadata. Custo: um record e um mapper por agregado |
| C. Records com decorators (`@mikro-orm/decorators/legacy`) | Descartada: o mesmo boilerplate de B, mais um pacote e dependência de decorators legados e metadata |

**Estratégia transacional:** as escritas usam `em.transactional()` e leem a wallet com `em.findOne(WalletRecord, id, { lockMode: LockMode.PESSIMISTIC_WRITE })` (`SELECT ... FOR UPDATE`), o que serializa por `walletId`, sem lock global (D21, D24). **SQL cru só com justificativa explícita**, registrada na tabela abaixo.

| Onde | Por que SQL cru |
|---|---|
| `DatabaseHealth.check` (`getConnection().execute("select 1")`) | É o próprio health check do banco: a consulta mais barata que abre conexão (D6) |
| Migrations (`src/infrastructure/database/migrations`) | Por desenho: constraints, índices parciais e triggers são escritos à mão (D7, D17) |

As demais consultas usam a API do MikroORM ou o query builder Kysely embutido nele (D36, D42), que gera SQL parametrizado e tipado. SQL escrito à mão aparece também nos testes, para provocar e conferir estados do banco.

### D4. Configuração: zod + `AppConfig` tipado

O `AppConfig.fromEnv(process.env)` valida o env com um schema zod e devolve um objeto tipado e congelado, registrado como provider global; a própria classe serve de token de DI. Com env inválido, a app não sobe e lista todas as variáveis com problema.

Não usamos `@nestjs/config`: o Bun já carrega `.env` e `.env.<NODE_ENV>`, e a validação é o próprio schema. As credenciais da AWS não passam pelo `AppConfig`, porque o SDK as lê pela cadeia padrão de credenciais (env, perfil ou role). Assim, o mesmo código serve para o emulador e para a AWS real.

### D5. Logs estruturados: nestjs-pino

| Opção | Prós | Contras |
|---|---|---|
| `ConsoleLogger({ json: true })` do Nest | Zero dependência | Sem log de request, sem contexto por request, campos aninhados em `params` |
| **nestjs-pino (escolhida)** | Padrão de mercado e rápido; os logs do próprio Nest e do MikroORM saem em JSON; log de request; contexto por request via AsyncLocalStorage; `PinoLogger.runInContext` leva o mesmo contexto para handlers fora do HTTP | 3 dependências (pino, pino-http, nestjs-pino) |
| pino puro + adapter próprio | 1 dependência | Reescrever o LoggerService e o log de request |
| winston | Flexível | Mais lento e pesado, sem vantagem aqui |

Formato: uma linha JSON por evento com `level` (label), `time` (ISO-8601), `service`, `pid`, `hostname` (identifica a instância), `context` e `message`.

- **correlationId:** vem do header `x-correlation-id` quando bate com `^[A-Za-z0-9._:-]{1,128}$`, o que impede injeção de conteúdo arbitrário no log. Caso contrário, é gerado um UUID. O valor volta no header da resposta e aparece em todo log emitido durante a requisição.
- **Dados sensíveis:** os serializers de request e response são allowlist, só `method`, `url` e `statusCode`. Headers e corpo nunca são logados. Isso é mais forte que redaction, porque nada entra por padrão.
- `/health/*` e `/metrics` ficam fora do log automático de request, para não poluir com probes e scrapes. Falhas de readiness são logadas em `warn`, com a causa.
- **Fora do HTTP**, o consumer SQS e os workers rodam cada mensagem ou ciclo em `PinoLogger.runInContext(fn, { bindings })`. `transactionId`, `walletId` e `providerId` entram via `assign` em todos os caminhos, e o serializer de erros é allowlist com máscara de valores (D47).

### D6. Health checks

- **`GET /health/live`:** sempre 200 enquanto o processo responde. Não consulta dependências, para que uma queda do banco não faça o orquestrador reiniciar todas as instâncias em cascata.
- **`GET /health/ready`:** checa Postgres (`select 1`) e SQS (`GetQueueAttributes` na fila de entrada, na DLQ e na fila de eventos) em paralelo, cada um com timeout `HEALTH_CHECK_TIMEOUT_MS`. Devolve 200 `{status:"ok", checks}` ou 503 `{status:"unavailable", checks}`, e cada dependência fica `up` ou `down` com `reason` igual a `timeout` ou `unavailable`. O endpoint é aberto, então a resposta não expõe mensagens de erro, hosts nem stack. Esses detalhes vão para o log.
- Escritos à mão, sem `@nestjs/terminus`: são duas checagens, e o `MikroOrmHealthIndicator` do terminus tem histórico de incompatibilidade com `defineConfig`.
- **O MikroORM 7 conecta sob demanda.** O `MikroORM.init` não abre conexão, e o primeiro `execute` faz isso. Consequência: a app sobe mesmo com o banco fora, o `/ready` responde 503 e volta a 200 sozinho quando o banco volta. Por isso o check usa `execute("select 1")` e não `checkConnection()`, que só informa "não conectado" antes da primeira query.
- A URL de cada fila é resolvida uma vez por `GetQueueUrl` e guardada em cache (`QueueUrlResolver`). Isso independe do emulador e do formato de URL.

### D7. Migrations

- Ficam em `src/infrastructure/database/migrations`, em TypeScript, cada uma com `up()` **e** `down()`. Usam `snapshot: false` porque o schema (constraints, índices, triggers de imutabilidade) é escrito à mão em SQL, e não gerado por diff de entidades.
- Rodam por comando, **nunca na subida da app**, para que várias instâncias não concorram para migrar o mesmo banco: no desenvolvimento, `bun run db:migrate`; no compose, o serviço one-shot `migrate` (`src/migrate.ts`, D51), do qual as réplicas dependem.
- A CLI do MikroORM é invocada como `bun ./node_modules/@mikro-orm/cli/cli.js`. Executada pelo caminho do arquivo, o Bun carrega `.env` e `.env.<NODE_ENV>` automaticamente; via `bunx`, não carrega. Com isso, `NODE_ENV=test bun run db:migrate` migra o banco de testes.
- `test/integration/database/migrations.test.ts` prova a reversibilidade: aplica todas, desfaz uma a uma até zero (sem sobrar tabela, constraint, índice, trigger nem função) e aplica de novo, com o schema idêntico ao da primeira vez.

### D8. Infra dos testes de integração

| Opção | Prós | Contras |
|---|---|---|
| **Compose já rodando (escolhida)** | Rápido; mesma infra do desenvolvimento; os testes multiprocesso (D48) só precisam de host e porta | Exige `docker compose up -d --wait` antes; o isolamento é responsabilidade dos testes |
| testcontainers | Hermético | +5 a 15 s por execução; a compatibilidade com Bun só se estabilizou recentemente; o módulo de LocalStack assume a imagem com token |

Isolamento:
1. **Banco separado** `wagering_test`, criado pelo init do Postgres e selecionado pelo `.env.test`.
2. **Serialização entre arquivos:** o `bun test` roda os arquivos em série por padrão. Como garantia que não depende de flag, `useIntegrationEnvironment()` toma `pg_advisory_lock(<chave fixa>)` numa conexão dedicada (`Bun.SQL.reserve()`, sem dependência nova) no `beforeAll` e libera no `afterAll`. Com `bun test --parallel`, que distribui os arquivos entre processos, os arquivos de integração esperam uns pelos outros. **Verificado:** dois arquivos em processos distintos executaram em sequência estrita, o segundo começando só depois de o primeiro liberar o lock. Os processos da aplicação que os testes multiprocesso sobem (D48) não pedem esse lock. A espera pelo lock vai até 600 s, o suficiente para a suíte inteira no `--parallel`, e `useIntegrationEnvironment({ testTimeoutMs })` dá timeout próprio por arquivo (30 s por padrão, 120 s nos multiprocesso).
3. **Preflight:** se Postgres ou SQS não respondem, o arquivo falha de imediato com a instrução de subir a infra.
4. **Limpeza:** `resetDatabase()` recria o schema uma vez por arquivo, sempre dentro do lock, sem desligar os triggers de imutabilidade (D20).

Alternativa registrada: um banco por arquivo via `CREATE DATABASE ... TEMPLATE`. Daria paralelismo real, mas a complexidade não compensa no tamanho desta suíte.

## 6. Domínio

O código fica em `src/domain`, em TypeScript puro: não importa NestJS, MikroORM nem AWS SDK, e também não importa as outras camadas. O teste `test/unit/architecture/dependency-rule.test.ts` garante isso (D16). A única dependência externa é o `node:crypto` (D13).

Convenções:
- Construtor `private` com factories (`create`, `open`, `opening`, `enqueue`, `receive`, `from`). O `rehydrate(state)` reconstrói o estado persistido sem revalidar transições.
- O domínio não gera ids nem lê o relógio (D14).
- Rejeições de negócio são valores (`FailureCode`). Exceções ficam para entrada inválida (`DomainError`) e para erro de programação (`InvariantViolationError`) (D15).

### D9. Money: `bigint` em centavos, escala fixa de 2 casas

| Opção | Resultado |
|---|---|
| **`bigint` em centavos (escolhida)** | A escala é garantida pela própria representação, porque não existe terceira casa; aritmética nativa e exata; zero dependência; sem config global. `JSON.stringify` lança erro com `bigint`, então o valor cru nunca é serializado por engano: a saída passa sempre por `toJSON()` |
| `decimal.js` | Bateria com o `Decimal` do modelo de referência do enunciado, mas a precisão é arbitrária (a escala vira validação, não tipo), a config é global e o parser aceita `1e3`, `Infinity` e `0x10`, o que exigiria a mesma regex estrita de qualquer forma |
| `big.js` / `dinero.js` | Os mesmos contras de `decimal.js`, ou uma API maior que a necessidade |

Nomes e assinaturas do modelo podem ser adaptados desde que as garantias sejam preservadas (enunciado, seção 6). O contrato externo continua o do enunciado: `{ "amount": "25.00", "currency": "BRL" }`.

**Entrada (`Money.from`)** exige `amount` como string com **exatamente 2 casas decimais**, pela leitura literal do requisito (enunciado, seção 6.1: Money "recebido e serializado ... sempre com escala fixa de 2 casas"). A regex é `^(0|[1-9]\d{0,16})\.\d{2}$`, só ASCII. Cada rejeição traz um `InvalidMoneyError.reason` estável:

| Motivo | Exemplos |
|---|---|
| `INVALID_FORMAT` | `""`, `" 25.00"`, `"+25.00"`, `"NaN"`, `"Infinity"`, `"1e3"`, `"0x10"`, `"25,00"`, `".50"`, `"025.00"`, número em vez de string |
| `INVALID_SCALE` | `"25"`, `"25.5"`, `"10.005"`: escala diferente de 2, **rejeitada e nunca arredondada** |
| `NEGATIVE_AMOUNT` | `"-5.00"`, `"-0.00"` |
| `OUT_OF_RANGE` | Mais de 17 dígitos inteiros, o que não cabe em `numeric(19,2)` (D18). Rejeitar aqui vira 400, e não um erro de banco (500) |
| `INVALID_CURRENCY` | Fora de `^[A-Z]{3}$`. Só o formato ISO-4217 é validado; uma lista de moedas suportadas, se necessária, vira config da aplicação |

**Política de arredondamento: nunca arredondar implicitamente.** As operações do domínio (`add`, `subtract`, `negate`) são fechadas em escala 2 e nunca precisam arredondar. Se um dia surgir divisão ou percentual (taxa, reembolso parcial), o arredondamento será explícito no método, com modo nomeado (HALF_EVEN). Valores negativos só nascem de operações internas, como um saldo projetado, e saem como `"-0.05"`. Moedas diferentes em `add`, `subtract` e `isLessThan` lançam `CurrencyMismatchError`; `equals` devolve `false`.

### D10. `WagerTransaction` e transições de status

| De \ ação | `markProcessed` | `markPendingReference` | `reject` | `fail` |
|---|---|---|---|---|
| `PENDING` | → PROCESSED | → PENDING_REFERENCE | → REJECTED | → FAILED |
| `PENDING_REFERENCE` | → PROCESSED | → PENDING_REFERENCE (nova tentativa) | → REJECTED | → FAILED |
| `PROCESSED` / `REJECTED` / `FAILED` | `InvalidTransactionStateError` | idem | idem | idem |

- Os estados terminais não mudam mais. Tentar transicioná-los é erro de programação. Não existe volta para PENDING.
- `create` nasce em PENDING e valida o payload (`InvalidWagerTransactionError.reason`):
  - campos em branco (`BLANK_FIELD`);
  - OPENING vindo de fora (`INTERNAL_KIND`);
  - kind desconhecido (`UNKNOWN_KIND`);
  - provider `internal`, que é reservado (`RESERVED_PROVIDER`);
  - REFUND ou ROLLBACK sem referência (`REFERENCE_REQUIRED`);
  - BET com referência (`REFERENCE_NOT_ALLOWED`);
  - referência para si mesma (`SELF_REFERENCE`);
  - valor zero em BET, WIN, REFUND ou ROLLBACK (`NON_POSITIVE_AMOUNT`). LOSS aceita `0.00`, porque vários provedores enviam LOSS zerado.
- WIN e LOSS **podem** referenciar uma BET da mesma rodada; quando referenciam, seguem as mesmas validações e o mesmo fluxo de espera.
- O **`payloadHash` é calculado pelo próprio `create`** (D13), então não existe transação com hash inconsistente com os próprios dados.
- **OPENING** é criado só por `WagerTransaction.opening(...)`, já PROCESSED, com identificadores reservados: `providerId = "internal"`, `externalTransactionId = roundId = "opening:<walletId>"`, `idempotencyKey = "internal:opening:<walletId>"`, `gameId = "wallet-opening"`.
- **Campos além do modelo de referência do enunciado:**
  - `observedBalance`: o saldo visto no desfecho (PROCESSED ou REJECTED). É o "saldo observado naquele momento" que o replay precisa devolver (enunciado, seção 7: repetir uma operação processada devolve o resultado original), inclusive para LOSS e REJECTED, que não geram lançamento.
  - `updatedAt`.
  - `referenceAttempts` e `nextReferenceAttemptAt`, para o reprocessamento de PENDING_REFERENCE (D12).
- `reject` aceita só `RejectionCode` e `fail` só `FailedCode`, ambos subconjuntos de `FailureCode`. O compilador impede trocar um pelo outro.
- **FAILED não tem produtor.** O status e o código `PROCESSING_RETRIES_EXHAUSTED` existem no modelo e no schema, mas nenhum fluxo grava FAILED: uma falha de infraestrutura desfaz a transação SQL e é retentada (503 com reenvio pelo cliente no HTTP, D26; backoff e, esgotado o `maxReceiveCount`, DLQ no SQS, D31). Ficam como ponto de extensão para um processamento que precise registrar uma falha definitiva.

### D11. Wallet, ledger e `version`

- `debit(movement)` e `credit(movement)` recebem `{ entryId, transactionId, money, at }` e **devolvem o `WalletLedgerEntry`** daquele movimento. Saldo e lançamento saem juntos porque:
  1. não existe outra forma de alterar o saldo (sem setter; `rehydrate` só reconstrói);
  2. o método monta o lançamento com os mesmos `balanceBefore` e `balanceAfter` que aplica, e só altera a wallet **depois** que o lançamento foi validado;
  3. `WalletLedgerEntry.create` confere `balanceBefore ± money = balanceAfter`, moeda única, valor positivo e saldos não negativos.

  O lançamento devolvido é o que a submissão persiste na mesma transação SQL e usa no `WalletBalanceChanged` (D24).
- `debit` além do saldo lança `InsufficientBalanceError`, um erro de invariante: o caminho de negócio consulta `canDebit` antes e transforma o resultado em `FailureCode` (D12). O saldo nunca fica negativo, nem em memória.
- Cada lançamento carrega `walletVersion`, a versão da wallet que ele produziu (OPENING = 1). É a ordem total por wallet usada no schema e no cursor (D17, D22).
- **`version = 1 + número de lançamentos da wallet, sem contar o OPENING`.** `Wallet.open` cria com `version = 1` e já devolve o lançamento CREDIT de abertura quando o saldo inicial é positivo, como no exemplo do enunciado (seção 9: wallet criada com saldo 1000.00 e version 1). Cada `debit` ou `credit` posterior soma 1. LOSS e rejeições não mexem na version.
- O `WalletLedgerEntry` é estruturalmente imutável: campos `readonly`, `Object.freeze` e nenhum método de transição. As datas do domínio são guardadas como epoch e entregues como cópias, porque `Date` é mutável em JS.
- Um teste de propriedade aplica 1000 movimentos aleatórios, com seed fixa, e confere: saldo igual ao reconstruído pelo ledger, todos os lançamentos balanceados, `balanceBefore` de cada um igual ao `balanceAfter` do anterior, saldo nunca negativo e `version = 1 + lançamentos sem o OPENING`.
- A unicidade de wallet por `playerId + currency` não pode ser garantida em memória. Fica com o índice único `wallets_player_currency_key` (D17).

### D12. Regras por kind, referências e taxonomia de `FailureCode`

`settleWagerTransaction` (`src/domain/wagering/wager-settlement.ts`) é o serviço de domínio que aplica as regras de negócio (enunciado, seção 7: efeito de cada kind e validação das referências). É uma função pura: recebe a transação (PENDING ou PENDING_REFERENCE), a wallet já travada pelo chamador, a referência resolvida por `(providerId, referenceExternalTransactionId)` (ou `undefined`), o fato `referenceAlreadyReversed` e o id do lançamento. Ela muta os agregados pelos próprios métodos deles e devolve o desfecho: PROCESSED (com ou sem lançamento), REJECTED com código, ou PENDING_REFERENCE.

As regras rodam numa **ordem determinística**, e a primeira violada decide:
1. Transação terminal, wallet que não é a da transação ou referência passada sem que a transação tenha uma → erro de programação. Nada é alterado.
2. A wallet não é do player → `WALLET_PLAYER_MISMATCH`.
3. Moeda da operação diferente da moeda da wallet → `CURRENCY_MISMATCH`.
4. Referência, nesta ordem:
   1. ausente → espera (D12.1);
   2. tipo incompatível → `REFERENCE_INVALID_KIND` (REFUND só aceita BET; ROLLBACK aceita BET, WIN ou REFUND; WIN e LOSS só aceitam BET);
   3. de outro player, wallet, rodada ou moeda → `REFERENCE_MISMATCH` (o provider é igual por construção);
   4. valor diferente, só em REFUND e ROLLBACK → `REFERENCE_AMOUNT_MISMATCH`;
   5. referência ainda não terminal → espera; REJECTED ou FAILED → `REFERENCE_NOT_PROCESSED`;
   6. REFUND ou ROLLBACK de referência já revertida → `REFERENCE_ALREADY_REVERSED`.
5. Efeito no saldo:
   - LOSS → PROCESSED, sem lançamento;
   - CREDIT → aplica;
   - DEBIT sem saldo → `INSUFFICIENT_FUNDS` (BET) ou `REVERSAL_INSUFFICIENT_FUNDS` (ROLLBACK de WIN ou REFUND);
   - DEBIT com saldo → aplica.

`checkReference` (itens 4.2 a 4.4) e `ledgerDirectionFor` ficam na `WagerTransaction`, porque dependem só das duas transações. O que cruza agregados (wallet, saldo, "já revertida") fica no serviço.

**`ledgerDirectionFor(reference?)`:**
- BET → DEBIT.
- WIN, REFUND e OPENING → CREDIT.
- LOSS → erro, porque não move saldo.
- **ROLLBACK → o inverso da direção da referência:** de BET vira CREDIT; de WIN ou REFUND, DEBIT.

**Uma referência só pode ser revertida uma vez, qualquer que seja o tipo.** A regra literal do enunciado ("pelo mesmo tipo de operação") permitiria um REFUND **e** um ROLLBACK da mesma BET, o que creditaria a aposta duas vezes. ROLLBACK de um REFUND continua permitido, porque a referência é outra (o próprio REFUND). Na submissão, `referenceAlreadyReversed` = "existe REFUND ou ROLLBACK PROCESSED apontando para esta referência" (D24), e o índice único parcial `wager_transactions_one_reversal_per_reference` garante o mesmo no banco (D17).

**D12.1. Referência fora de ordem** (enunciado, seção 7.1: reprocessar com backoff exponencial até um limite justificado e, esgotado, rejeitar com evento)**:** cada avaliação sem a referência chama `markPendingReference(now)`, que soma uma tentativa e agenda a próxima com backoff exponencial de 1 s × 2, com teto de 60 s. Depois de **8 tentativas** (≈ 183 s de espera acumulada: 1+2+4+8+16+32+60+60), a próxima avaliação rejeita com `REFERENCE_NOT_FOUND`, ou com `REFERENCE_NOT_PROCESSED` se a referência existe mas nunca terminou. Justificativa: a inversão típica (rede, fila) se resolve em segundos; minutos sem a referência indicam que ela não virá e que o provedor precisa agir.

**Taxonomia de `FailureCode`:**

| Código | Status | Quando | O que o provedor deve fazer |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | BET maior que o saldo | Desistir; o jogador está sem saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | ROLLBACK de WIN ou REFUND deixaria o saldo negativo | Escalar para tratamento manual; é situação operacional, não de jogador |
| `CURRENCY_MISMATCH` | REJECTED | Moeda diferente da moeda da wallet | Corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | não persistido | `playerId` não é o dono da `walletId`; a submissão responde 422 sem criar transação (D28) | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | REJECTED | Referência ausente depois do limite de tentativas | Enviar a referência e reenviar a operação com uma nova key |
| `REFERENCE_INVALID_KIND` | REJECTED | Tipo de referência não permitido para o kind | Corrigir o payload |
| `REFERENCE_MISMATCH` | REJECTED | Referência de outro player, wallet, rodada ou moeda | Corrigir o payload |
| `REFERENCE_AMOUNT_MISMATCH` | REJECTED | Valor do REFUND ou ROLLBACK diferente do valor da referência | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | REJECTED | A referência terminou REJECTED ou FAILED, ou nunca terminou | Desistir; não há o que reverter |
| `REFERENCE_ALREADY_REVERSED` | REJECTED | A referência já foi revertida | Desistir; a reversão já foi feita |
| `PROCESSING_RETRIES_EXHAUSTED` | FAILED | Reservado no modelo e no schema; nenhum fluxo o grava (D10) | — |

Erros de validação de payload não criam transação e não são `FailureCode`: viram `InvalidMoneyError` ou `InvalidWagerTransactionError`, cada um com `reason` estável, e o mapeamento para HTTP está em D23 e D27. O domínio ainda trata `WALLET_PLAYER_MISMATCH` como rejeição, mas a submissão confere o dono da wallet antes do settlement e responde 422 sem persistir (D28).

### D13. `payloadHash`

- **Fica no domínio** (`src/domain/wagering/wager-payload.ts`):
  - "mesma key com payload diferente é conflito" é regra de negócio, e escolher os campos que identificam a operação é conhecimento de domínio;
  - o `create` calcula o hash a partir dos próprios campos;
  - é síncrono, determinístico e sem I/O; o `node:crypto` é biblioteca padrão do runtime.
- **Campos:** `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId` (omitido quando ausente). O `Idempotency-Key`, o `messageId`, o `occurredAt`, o `type` e qualquer metadado de transporte ficam de fora. A função copia campo a campo, então propriedades extras nunca entram.
- **JSON canônico:** chaves ordenadas recursivamente por code unit UTF-16, sem espaços, strings escapadas por `JSON.stringify`, chaves `undefined` omitidas e só strings como valores. É compatível com a RFC 8785 (JCS) nesse subconjunto.
- **Digest:** SHA-256, em hex minúsculo (64 caracteres).
- **Vetor dourado** (o exemplo de submissão do enunciado, seção 9): o JSON canônico `{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-…","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-…"}` gera `629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344`. O teste fixa esse valor, calculado de forma independente com `sha256sum`. Qualquer mudança que invalidaria os hashes já gravados quebra o teste.

### D14. Ids e datas por parâmetro

Factories e transições recebem `id`, `entryId` e `at` explicitamente. Os testes usam valores fixos e são totalmente determinísticos. As portas `Clock` e `IdGenerator` ficam na aplicação (D21), implementadas na infra com `new Date()` e `Bun.randomUUIDv7()`. No domínio, elas só acrescentariam indireção.

### D15. Backoff do outbox e erros de domínio

- **`OutboxMessage.scheduleRetry(now)`:** `attempts + 1` e próxima tentativa em `min(1 s × 2^(attempts−1), 5 min)`, sem jitter. **Sem limite de tentativas:** um evento confirmado nunca é descartado. Depois do teto, continua tentando a cada 5 min, e o atraso aparece na métrica de outbox lag (`wagering_outbox_oldest_pending_age_seconds`, D44). O jitter só ajudaria com muitos publishers sincronizados, e cada linha tem a própria agenda. O `OutboxMessage.enqueue(event)` usa `eventId` como id e guarda `event.toJSON()` congelado como payload.
- **`DomainError`** (com `code`; vira 4xx, D23): `InvalidMoneyError`, `CurrencyMismatchError`, `InvalidWagerTransactionError`.
- **`InvariantViolationError`** (bug do chamador; vira 500): `InvalidTransactionStateError`, `InvalidOutboxStateError`, `InvalidInboxStateError`, `InsufficientBalanceError`, `InvalidLedgerEntryError`, `InvalidOperationError`.
- Eventos de integração: cada subclasse fixa `eventType` e `version = 1` no tipo. O `data` carrega só `MoneyProps` e strings ISO-8601, é congelado em profundidade e o `from` recusa um agregado no estado errado. O `WalletBalanceChanged.from` exige que o lançamento seja o último movimento da wallet, para que `walletVersion` e `balanceAfter` sejam coerentes.

### D16. Teste de arquitetura

`test/unit/architecture/dependency-rule.test.ts` lê todo `.ts` de `src/domain` e `src/application` e extrai os imports por regex sobre o texto, o que pega também `import type`, `export … from`, `import()` e `require`. Ele falha quando:
- aparece `@nestjs/*`, `@mikro-orm/*` ou `@aws-sdk/*`;
- `domain` importa de outra camada;
- `application` importa de `infrastructure` ou `interfaces`.

Para não passar vazio, o teste exige que `src/domain` tenha arquivos, e um auto-teste prova que o scanner reconhece cada forma de import. Verificado manualmente: um arquivo de prova com `import "@nestjs/common"` e um `import type` da infraestrutura fez o teste falhar apontando as duas violações.

## 7. Persistência e API de wallets

O domínio chega ao PostgreSQL por migrations escritas à mão, records `defineEntity`, mappers e repositórios atrás de portas da aplicação. Os endpoints de wallet ficam atrás de um `AuthGuard` no-op (seção 13).

### D17. Schema e tabela de garantias

São 7 migrations em `src/infrastructure/database/migrations`, todas com `up` e `down`: `wallets`, `wager_transactions`, `wallet_ledger_entries`, os triggers de coerência, `inbox_messages`, `outbox_messages` e a sétima, com a ordem por wallet do outbox (D36), o `correlation_id` da transação (D39) e o índice das dependentes (D38). Cada regra tem um nome `<tabela>_<regra>`. **As regras impostas por trigger levantam `check_violation` com `CONSTRAINT = '<nome>'`.** Assim, `CHECK`, `UNIQUE`, FK e trigger chegam à aplicação e aos testes do mesmo jeito, pelo campo `constraint` do erro.

| Garantia | Onde |
|---|---|
| Uma wallet por `player_id + currency` | `wallets_player_currency_key` |
| Saldo nunca negativo | `wallets_balance_non_negative`; o ledger também tem `wallet_ledger_entries_balances_non_negative` |
| `version` sobe exatamente 1 quando o saldo muda e não muda quando o saldo não muda | trigger `wallets_version_follows_balance` |
| Identidade da wallet imutável | trigger `wallets_identity_immutable` |
| Idempotência persistente | `wager_transactions_idempotency_key` = `UNIQUE (provider_id, idempotency_key)` (D19) |
| Um id externo por provider; resolução de referência | `wager_transactions_external_id_key` |
| Uma reversão por referência, qualquer que seja o tipo (D12) | índice único parcial `wager_transactions_one_reversal_per_reference` em `reference_transaction_id` `WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| Regras de kind iguais às do domínio | `wager_transactions_amount_by_kind`, `_reference_by_kind`, `_no_self_reference`, `_opening_is_internal` |
| Coerência entre status e campos | `wager_transactions_*_by_status` (failure code, `processed_at`, `observed_balance`, agenda de PENDING_REFERENCE, referência resolvida) |
| Transação terminal imutável; payload e `correlation_id` imutáveis; sem volta para PENDING; sem DELETE/TRUNCATE | trigger `wager_transactions_guard` (`_terminal_immutable`, `_payload_immutable`, `_transition_valid`, `_append_only`) |
| No máximo um lançamento por transação por wallet | `wallet_ledger_entries_one_per_transaction` |
| Lançamento só aponta para transação da mesma wallet e na moeda da wallet | FKs compostas `wallet_ledger_entries_transaction_wallet_fkey` e `_wallet_currency_fkey` |
| `balance_before ± amount = balance_after` | `wallet_ledger_entries_arithmetic` (exato em `numeric`) |
| Ordem total e densa por wallet | `wallet_ledger_entries_wallet_version_key` (D22) |
| Ledger imutável | trigger `wallet_ledger_entries_append_only` (UPDATE, DELETE e TRUNCATE, por linha e por comando) |
| Toda alteração de saldo tem lançamento | constraint trigger deferido `wallets_balance_matches_ledger` |
| O lançamento continua o anterior | constraint trigger deferido `wallet_ledger_entries_chained` |
| Todo lançamento corresponde a uma transação PROCESSED, não LOSS, de mesmo valor e moeda e com a direção do kind (ROLLBACK = o inverso do lançamento da referência) | constraint trigger deferido `wallet_ledger_entries_match_transaction` |
| Deduplicação persistente de mensagens | PK `inbox_messages_pkey (consumer_name, message_id)` |
| Envelope do outbox coerente com as colunas | `outbox_messages_payload_envelope` |
| Evento pendente não se perde; conteúdo, `ordering_key` e `position` imutáveis; publicado só uma vez | trigger `outbox_messages_guard` (`_retention`, `_content_immutable`, `_published_once`) |
| Tamanho de `correlation_id` e de `ordering_key` | `wager_transactions_correlation_id_bounds`, `outbox_messages_ordering_key_bounds` |

**Coerência deferida.** Os três *constraint triggers* são `DEFERRABLE INITIALLY DEFERRED`: rodam no COMMIT, quando wallet, transação e lançamento já estão todos gravados. As FKs continuam imediatas, então a ordem de inserção é fixa (wallet → transação → lançamento → outbox). As mensagens nomeiam a regra e os valores, e o `DETAIL` traz `chave=valor` para log. Exemplo real:

```
wallet_ledger_entries_match_transaction: entry … for transaction … (ROLLBACK of WIN …) has direction CREDIT, expected DEBIT
DETAIL: wallet_id=… wallet_version=3 transaction_id=… kind=ROLLBACK reference_transaction_id=… reference_direction=CREDIT expected_direction=DEBIT received_direction=CREDIT
```

**Índices parciais para os workers e o `/metrics`:**
- `wager_transactions_pending_reference_due` (PENDING_REFERENCE, por `next_reference_attempt_at`): a lista de vencidas do worker (D38) e a contagem do backlog (D44);
- `wager_transactions_waiting_for_reference` (PENDING_REFERENCE, por `provider_id, reference_external_transaction_id`): o empurrão das dependentes (D38);
- `outbox_messages_pending_by_ordering_key` (pendentes, por `ordering_key, position`) e `outbox_messages_pending_due` (pendentes, por `coalesce(next_attempt_at, occurred_at), id`): as consultas sobre eventos pendentes, isto é, a reivindicação das cabeças (D36) e a sonda do outbox lag (D44).

O `wallet_ledger_entries_wallet_version_key` é também o índice da paginação (D22) e da soma da reconciliação (D42).

### D18. Dinheiro no banco: `numeric(19,2)`

| Opção | Resultado |
|---|---|
| **`numeric(19,2)` (escolhida)** | Legível em auditoria; a aritmética do lançamento é um `CHECK` exato; `SUM()` da reconciliação sai em reais; o `pg` devolve `"975.00"`, que entra direto em `Money.from` com a mesma regra de 2 casas; os 17 dígitos inteiros são exatamente o teto `OUT_OF_RANGE` do domínio |
| `bigint` de centavos | Igual ao interno do domínio, mas ilegível em SQL ad hoc, obrigaria o domínio a expor centavos e **não comporta o teto do domínio** (`int8` vai até 92.233.720.368.547.758,07) |

A moeda fica em `char(3)` com `CHECK (currency ~ '^[A-Z]{3}$')`. Observação para quem usa o `Bun.SQL` em testes: no protocolo binário ele devolve o `numeric` zero como `"0"`; os testes fazem `::text` nas asserções. A aplicação usa o `pg`, que sempre devolve as 2 casas.

### D19. Escopo da idempotency key: por provider

`UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. Com unicidade global, o provider A poderia usar a key `provider-b:tx-1` e bloquear o B, ou receber o replay da resposta do B, com o saldo de um jogador alheio. Com a key separada por provider, a busca de replay é sempre `(provider_id, idempotency_key)` e usa o próprio índice. O OPENING usa o provider reservado `internal`.

### D20. Imutabilidade e limpeza do banco de testes

Os triggers `BEFORE UPDATE OR DELETE` (por linha) e `BEFORE TRUNCATE` (por comando) disparam para qualquer usuário, inclusive o dono e superusuários; a única exceção é `session_replication_role = replica`, que a aplicação nunca usa; só o teste de divergência da reconciliação a liga, dentro de uma transação da própria sessão de teste (D42). `TRUNCATE wallets CASCADE` também falha, porque os triggers de TRUNCATE disparam nas tabelas alcançadas pelo cascade. Defesa em profundidade sugerida para produção (fora do escopo): rodar a app com um role sem `UPDATE`, `DELETE` e `TRUNCATE` no ledger.

**Os testes nunca limpam com DML.** `resetDatabase()` (`test/support/database.ts`) roda `DROP SCHEMA public CASCADE; CREATE SCHEMA public` e depois o `migrator.up()`, uma vez por arquivo, dentro do advisory lock (D8). DDL não passa pelos triggers de DML, então **os triggers ficam ativos em todos os testes**, sem bypass. Dentro de um arquivo, os testes se isolam com ids novos. O reset recusa qualquer banco cujo nome não termine em `_test`. Alternativa descartada: `session_replication_role = replica` + `TRUNCATE`, que exige superusuário e desliga também as FKs.

### D21. Persistência: records, mappers, repositórios e transação

- **Records** `defineEntity` em `src/infrastructure/database/records`, só dados e sem relações declaradas. **Mappers** convertem record ↔ domínio via `rehydrate` e `Money.from`/`toJSON`.
- **Portas** em `src/application/ports` (abstract classes que servem de token de DI): `WalletRepository`, `WagerTransactionRepository`, `WalletLedgerRepository`, `InboxRepository`, `OutboxRepository`, `EventPublisher`, `TransactionRunner`, `Clock`, `IdGenerator`. **Adaptadores** em `src/infrastructure/database/repositories`, `src/infrastructure/messaging` (`SqsEventPublisher`) e `src/infrastructure/system` (`new Date()`, `Bun.randomUUIDv7()`). Os casos de uso não importam Nest; são ligados por `useFactory` nos módulos de entrada (`WalletsModule`, `WageringUseCasesModule`, `SqsConsumerModule`, `WorkersModule`).
- **Inserções com `em.insert`**, que executa na hora e na ordem chamada. Records sem relações não informam ao Unit of Work a ordem das FKs, então o `persist` + `flush` poderia inserir fora de ordem.
- **Atualização da wallet:** `findByIdForUpdate` = `em.findOne(…, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true })` (`SELECT … FOR UPDATE`, exige transação aberta) e `update` = `em.assign` + `flush` sobre o record carregado. É o caminho de D3 que a submissão usa (D24).
- **Transação:** `MikroOrmTransactionRunner.run(work)` = `em.transactional(() => work())`, e `readSnapshot(work)` abre uma transação `REPEATABLE READ READ ONLY` para leituras consistentes (D42). O MikroORM guarda o fork transacional num `AsyncLocalStorage`, e os repositórios, que recebem o `EntityManager` global, entram nele automaticamente. **Cuidado:** um `em.fork()` comum tem `useContext: false` e ignora esse contexto, gravando fora da transação. Os testes que montam repositórios à mão usam `fork({ useContext: true })`. Isso foi descoberto quando o trigger `wallets_balance_matches_ledger` barrou um commit em que a wallet tinha sido gravada fora da transação.
- **Tradução de erros:** `UniqueConstraintViolationException` com `constraint = 'wallets_player_currency_key'` vira `WalletAlreadyExistsError`. Qualquer outra violação sobe como está (bug → 500).
- **SQL cru:** só os casos registrados em D3.

`POST /wallets` faz, numa transação SQL: `Wallet.open` → wallet; se o saldo inicial for positivo, `WagerTransaction.opening` → transação → lançamento CREDIT de abertura → outbox com `WagerTransactionProcessed` e `WalletBalanceChanged`, que levam o `correlationId` da requisição. Se a wallet já existir, a aplicação busca o id da existente depois do rollback e o devolve no 409.

### D22. Paginação do ledger por cursor

`GET /wallets/:walletId/ledger?cursor=&limit=` devolve `{ items, nextCursor }`, do mais recente para o mais antigo, com `limit` padrão 50 e máximo 200. O cursor é `base64url(JSON.stringify({ w: walletId, v: walletVersion }))`, onde `v` é a última versão devolvida, e a próxima página busca `wallet_version < v` (busca `limit + 1` para saber se há próxima).

**Por que é estável:**
- a chave `(wallet_id, wallet_version)` é única e imutável (ledger append-only);
- `wallet_version` é atribuída sob o lock da wallet e cresce estritamente, então um lançamento novo sempre recebe uma versão maior que todas as existentes: aparece antes da primeira página e nunca entre páginas já lidas;
- nada pode ser apagado.

Comparação: `OFFSET` desloca as páginas a cada inserção, e um keyset por `created_at` empata e permite inserção "no meio" quando o relógio de outra instância está atrasado. O teste comprova isso: inserindo 3 lançamentos durante a paginação, um deles com `created_at` no passado, as páginas seguintes continuam exatas. Um INSERT "no meio" (versão já existente) falha em `wallet_ledger_entries_wallet_version_key`.

O cursor é opaco e tem escopo: um cursor de outra wallet, adulterado ou com versão inválida dá 400 `INVALID_CURSOR`.

### D23. Convenção de erros HTTP (RFC 9457)

Todo erro sai como `application/problem+json`, gerado pelo filtro global `ProblemDetailsFilter`:

```json
{
  "type": "urn:wagering:problem:wallet-already-exists",
  "title": "Wallet already exists",
  "status": 409,
  "detail": "Player … already has a BRL wallet",
  "instance": "/wallets",
  "code": "WALLET_ALREADY_EXISTS",
  "retryable": false,
  "correlationId": "…",
  "walletId": "…"
}
```

`code` é o identificador estável para máquina, `retryable` diz se reenviar o mesmo pedido pode dar certo, e as extensões variam por problema (`errors` na validação, `reason` em `INVALID_MONEY`, `walletId` no 409).

| Situação | Status | `code` | `retryable` |
|---|---|---|---|
| Corpo, parâmetro ou query fora do schema (zod via Standard Schema) | 400 | `VALIDATION_FAILED` + `errors[]` | false |
| JSON malformado | 400 | `MALFORMED_REQUEST` | false |
| Money inválido | 400 | `INVALID_MONEY` + `reason` | false |
| Cursor inválido | 400 | `INVALID_CURSOR` | false |
| Wallet inexistente | 404 | `WALLET_NOT_FOUND` | false |
| Rota inexistente | 404 | `ROUTE_NOT_FOUND` | false |
| Wallet duplicada | 409 | `WALLET_ALREADY_EXISTS` + `walletId` | false |
| Transação inexistente | 404 | `TRANSACTION_NOT_FOUND` | false |
| Banco inalcançável ou reiniciando, conexões esgotadas, lock timeout, deadlock | 503 + `Retry-After: 1` | `DEPENDENCY_UNAVAILABLE` | true |
| Erro inesperado ou de invariante | 500 | `INTERNAL_ERROR` | false |

Os códigos da submissão de transações (409 de idempotência, 422 de rejeição, 202 de referência pendente) estão em D27. Falha de serialização (`40001`) não entra no 503 porque não ocorre: nenhuma transação usa SERIALIZABLE, e a única em REPEATABLE READ é só leitura (D42). Se ocorresse, cairia no 500.

O `/health/ready` define o 503 por `@Res({ passthrough: true })` e não passa pelo filtro, mantendo o formato próprio de D6.

## 8. Submissão de transações

O caso de uso `SubmitWagerTransaction` (`src/application/wagering`), o mesmo para a entrada HTTP e para o consumer SQS (D29); `POST /wagering/transactions` e os dois GETs.

### D24. Sequência transacional

**Antes da transação SQL:**
1. `Money.from` + `WagerTransaction.create`: valida o payload (400) e calcula o `payloadHash`.
2. Busca rápida de idempotência, sem lock, por `(provider_id, idempotency_key)`. Se acha → replay ou 409. Assim, replays não disputam a wallet.

**Dentro de `em.transactional()` (READ COMMITTED):**

3. `findByIdForUpdate(walletId)` → `SELECT … FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`, `refresh: true`). Wallet inexistente → 404.
4. **Revalida a idempotência sob o lock.**
5. Dono da wallet (D28).
Os passos 6 a 9 ficam no `SettleAndRecord`, o mesmo que o worker de PENDING_REFERENCE usa (D38):

6. Resolve a referência por `(provider_id, reference_external_transaction_id)`.
7. `referenceAlreadyReversed` = existe REFUND ou ROLLBACK **PROCESSED** com `reference_transaction_id = referência` (`em.count`, servido pelo índice parcial `wager_transactions_one_reversal_per_reference`).
8. `settleWagerTransaction` (domínio).
9. Grava a transação → lançamento e wallet (se houve movimento) → outbox (`WagerTransactionProcessed`, `WalletBalanceChanged`, `WagerTransactionRejected` ou `WagerTransactionPendingReference`, com o `correlationId` da transação, D39, e o `causationId` da mensagem, quando há). Se a transação terminou (PROCESSED ou REJECTED), reagenda as dependentes que esperavam por ela (D38).
10. COMMIT, quando os triggers deferidos (D17) conferem a coerência.

**Por que a ordem é correta com várias requisições simultâneas:**
- O lock vem antes de toda leitura que decide o resultado, e toda escrita que mudaria esses fatos também exige o lock da mesma wallet:
  - payload igual implica `walletId` igual;
  - uma reversão PROCESSED da referência R só existe com a wallet de R travada, porque `checkReference` rejeita outra wallet e rejeição não grava reversão;
  - o saldo só muda com a wallet travada.
- Sob READ COMMITTED, cada comando lê o que já foi confirmado quando ele começa. A revalidação do passo 4 roda depois que o lock foi concedido, ou seja, depois do COMMIT de quem o segurava, então ela enxerga a transação concorrente.
- O `SELECT … FOR UPDATE` relê a versão mais recente da linha após a espera, então o saldo usado no settlement nunca é antigo (sem lost update).
- A busca do passo 2 é só um atalho: se erra para "não existe", o passo 4 corrige; se acha, a linha é confirmada e imutável.
- O instante do settlement nunca é anterior ao `createdAt` do candidato (`max(agora, createdAt)`), para que um ajuste de relógio não viole `updated_at >= created_at`.

### D25. Idempotência, replay e a unique como rede de segurança

- **Requisições idênticas simultâneas:** a segunda espera o lock, e a revalidação do passo 4 encontra a primeira → **replay** (`idempotentReplay: true`, mesmo `transactionId` e mesmo saldo). Elas não chegam a disputar a unique. Verificado com 50 envios paralelos: 1 processamento, 49 replays, 1 débito.
- **Rede de segurança:** o repositório traduz a violação de `wager_transactions_idempotency_key` e `wager_transactions_external_id_key` em `DuplicateWagerTransactionError`. O caso de uso deixa a transação SQL (abortada) fazer rollback e, fora dela, relê a linha vencedora: mesma key e mesmo hash → replay; hash diferente → 409 `IDEMPOTENCY_CONFLICT`; mesmo id externo com outra key → 409 `DUPLICATE_EXTERNAL_TRANSACTION_ID`. **Nunca 500.**
  - Esse caminho acontece de verdade quando a mesma key chega com payloads de wallets diferentes, que travam wallets diferentes e só se encontram na unique. O teste de concorrência cobre isso, mas cada rodada pode cair na revalidação ou na unique.
  - Para provar o caminho da unique de forma determinística, `test/integration/application/submit-wager-transaction.test.ts` usa uma subclasse do repositório real que "não enxerga" a linha nas duas primeiras buscas: o INSERT esbarra na unique do Postgres e o resultado é replay (ou 409), com o saldo intacto.
- **Uma violação de `wager_transactions_one_reversal_per_reference` não é traduzida.** Sob o lock ela é impossível; se ocorrer, é bug (500 no log), e o índice já impediu o crédito duplo. Verificado com REFUND e ROLLBACK da mesma BET em paralelo, 10 rodadas: sempre um PROCESSED e um `REFERENCE_ALREADY_REVERSED`.
- **Replay devolve o resultado original:** a linha de `wager_transactions` é o registro de idempotência. O `observed_balance` gravado no desfecho é imutável, então o replay mostra o saldo daquele momento mesmo que a wallet tenha mudado. Uma transação que ainda espera referência é devolvida no estado atual: depois que o worker a resolve (D38), o replay já mostra o desfecho final.

### D26. Lock timeout

`DB_LOCK_TIMEOUT_MS` (padrão 2000) vai para todas as conexões do pool como `driverOptions.options = '-c lock_timeout=<ms>'`, sem SQL cru. Esperar mais que isso pelo lock de uma wallet dá `55P03 lock_not_available`. Como o MikroORM não converte esse código, ele foi incluído em `isTransientDatabaseError`, e o filtro responde **503 `DEPENDENCY_UNAVAILABLE`, `retryable: true`, `Retry-After: 1`**. Nada é gravado, então reenviar a mesma requisição é seguro. Por que 2 s: cada transação segura o lock por milissegundos, então 2 s de espera já indicam saturação, e um 503 explícito é melhor que esgotar o pool. Testado com uma sessão segurando `FOR UPDATE` e a app com 300 ms: 503; depois de soltar o lock, o reenvio processa. Cada timeout desses conta em `wagering_lock_conflicts_total` (D45).

**Nos testes de concorrência, o cliente reenvia automaticamente ao receber 503, respeitando o `Retry-After`**, como um provedor faria. Os resultados esperados continuam exatos porque o reenvio é idempotente. Cada cenário registra quantos 503 recebeu, e o resumo sai no fim da execução. Com pool de 20 e lock timeout de 2 s, **todos os cenários tiveram 0 reenvios**: as duas apostas de 80.00 sobre 100.00 (enunciado, seção 8), mesma aposta 50×, wallet quente com 120 BETs, 10 wallets × 20 BETs, REFUND × ROLLBACK, mesma key em wallets diferentes e mesmo id externo com keys diferentes. A suíte rodou 5 vezes seguidas sem falha.

### D27. Contrato de status da submissão

O status HTTP depende só do status da transação e é igual no replay:

| Desfecho | HTTP | Corpo |
|---|---|---|
| PROCESSED | 200 | `{ transactionId, status, balance, idempotentReplay }` |
| PENDING_REFERENCE | 202 | o mesmo, com `balance: null` |
| REJECTED | 422 `application/problem+json` | `code` = `failureCode` + extensões `transactionId`, `transactionStatus`, `failureCode`, `balance` e `idempotentReplay` |
| Mesma key, outro payload | 409 | `IDEMPOTENCY_CONFLICT` + `transactionId` existente |
| Mesmo id externo, outra key | 409 | `DUPLICATE_EXTERNAL_TRANSACTION_ID` + `transactionId` existente |
| Jogador não é dono da wallet | 422 | `WALLET_PLAYER_MISMATCH`, sem persistir (D28) |
| Wallet inexistente | 404 | `WALLET_NOT_FOUND`, sem persistir |
| Sem `Idempotency-Key` / key inválida | 400 | `MISSING_IDEMPOTENCY_KEY` / `VALIDATION_FAILED` (a key aceita de 1 a 255 caracteres ASCII imprimíveis, sem espaço) |
| Payload inválido | 400 | `VALIDATION_FAILED`, `INVALID_MONEY` ou `INVALID_WAGER_TRANSACTION` (o `kind` é validado pelo domínio) |
| Lock timeout ou banco fora | 503 + `Retry-After` | `DEPENDENCY_UNAVAILABLE`, `retryable: true` |

Toda resposta de transação leva `Location: /wagering/transactions/:id`. No 422, o status da transação vai em `transactionStatus`, porque `status` é o código HTTP pela RFC 9457; o `problemDetails` garante que os campos padrão nunca são sobrescritos por extensões. `GET /wagering/transactions/:id` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` devolvem a visão completa; inexistente → 404 `TRANSACTION_NOT_FOUND`.

### D28. Erros não persistidos e dependentes em PENDING_REFERENCE

**`WALLET_PLAYER_MISMATCH`: 422 sem persistir.**

| Opção | Resultado |
|---|---|
| **422 sem persistir (escolhida)** | Não expõe nada da wallet alheia; determinístico (o reenvio dá o mesmo 422); auditável pelo log `warn` com `walletId` e `playerId` |
| Persistir como REJECTED | O `observed_balance` obrigatório exporia o saldo de **outra** wallet no replay e no evento |
| 404 | Esconderia o erro real do provedor |

**Dependentes em PENDING_REFERENCE não são processadas no mesmo pedido da referência.** Isso alongaria a transação, encadearia efeitos e faria uma falha da dependente derrubar a referência. Elas ficam com o worker, e o desfecho terminal da referência as reagenda para o instante seguinte (o "empurrão", D38).

**Erros não persistidos não geram evento.** `WALLET_PLAYER_MISMATCH`, wallet inexistente e payload inválido (`VALIDATION_FAILED`, `INVALID_MONEY`, `INVALID_WAGER_TRANSACTION`) não criam linha em `wager_transactions` nem evento no outbox. Pelo HTTP, o provedor recebe o 4xx. Pelo SQS, onde não há resposta, a mensagem vai para a DLQ com o motivo nos atributos (D30).

## 9. Consumer SQS

O consumer da fila `wager-transactions.fifo` (enunciado, seção 10: mesmo caso de uso do HTTP, inbox persistente por `(consumerName, messageId)`, ack só depois do commit, erros de negócio, transitórios e permanentes tratados de formas distintas e limite de tentativas antes da DLQ), reaproveitando o `SubmitWagerTransaction`.

### D29. Inbox na mesma transação, sem acoplar o caso de uso ao SQS

São três camadas:
- **`src/interfaces/sqs`:** o adaptador faz polling, valida o envelope, dá ack, aplica backoff e envia à DLQ. É o único que conhece o SQS.
- **`HandleWagerTransactionRequested` (`src/application/messaging/handle-wager-transaction-requested.ts`):** abre a transação externa, grava o `InboxMessage` (PK `(consumer_name, message_id)`) e chama `SubmitWagerTransaction.execute` com `causationId = messageId`.
- **O `SubmitWagerTransaction`:** não muda e não sabe que existe fila.

**Mecanismo:** a propagação padrão do `em.transactional` no MikroORM 7 é `NESTED`, então o `TransactionRunner.run` interno do caso de uso vira **savepoint** da transação externa. Inbox, transação, lançamento, wallet e outbox confirmam juntos ou nada. A rede de segurança da unique (D25: unique → rollback → relê) continua valendo, com rollback do savepoint.

**Ordem dos locks:** sempre PK do inbox → lock da wallet, então não há deadlock entre mensagens.

**Contexto do MikroORM por mensagem:** fora do HTTP não há o contexto por requisição, e o `EntityManager` global recusa leituras fora de transação (`allowGlobalContext: false`). O consumer roda cada mensagem em `DatabaseContext.run` (`RequestContext.create`), o equivalente do middleware HTTP. Sem isso, a releitura do inbox no caminho de duplicata falhava e a mensagem ficava em retry; foi o que o primeiro teste de redelivery acusou.

**Duplicatas e crash:**
- **Entrega repetida:** o INSERT do inbox falha na PK → rollback → o handler relê o inbox e devolve `DUPLICATE` → ack, sem efeito.
- **Entregas simultâneas** (visibilidade expirou e outra instância recebeu): o segundo INSERT espera a transação do primeiro e vira duplicata se o primeiro confirmar.
- **Crash depois do commit e antes do ack:** a reentrega cai no inbox e recebe ack sem efeito.
- **Crash antes do commit:** desfaz tudo, inclusive o inbox.
- Uma segunda camada vem da idempotência da transação: outro `messageId` com a mesma `idempotencyKey` é replay.

**`payloadHash` do inbox:** SHA-256 do JSON canônico de `{ type, data }` (`canonicalHash`, o mesmo de D13, em `domain/shared`). `messageId` e `occurredAt` ficam de fora. O mesmo `messageId` com outro payload → `InboxPayloadMismatchError` → DLQ com `INBOX_PAYLOAD_MISMATCH`; o efeito original fica intacto.

**O inbox só guarda mensagens tratadas:** a linha nasce já processada, na mesma transação. Mensagens que vão para a DLQ não têm linha.

### D30. Classificação de erros e destino dos não persistidos

| Situação | Classe | Ação |
|---|---|---|
| PROCESSED, REJECTED ou PENDING_REFERENCE persistido; replay idempotente; duplicata do inbox | negócio/terminal | **ack** |
| Corpo que não é JSON, envelope fora do schema, `type` desconhecido | permanente | **DLQ explícita**, `INVALID_MESSAGE` |
| `INVALID_MONEY`, `INVALID_WAGER_TRANSACTION`, `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `DUPLICATE_EXTERNAL_TRANSACTION_ID`, `INBOX_PAYLOAD_MISMATCH` | permanente | DLQ explícita, com o código |
| Banco indisponível, `55P03` (lock timeout), deadlock, falha do SQS | transitório | backoff (D31) |
| Qualquer outro erro (bug, invariante) | desconhecido → **transitório** | backoff; se persistir, DLQ pelo `maxReceiveCount`. Nunca é descartado |

**Destino dos erros não persistidos: DLQ explícita com atributos.** A mensagem vai para a DLQ com `MessageAttributes` `errorCode`, `errorMessage`, `consumerName`, `failedAt` e `receiveCount`, e então é apagada da fila principal. É a classificação do enunciado (seção 10: erros permanentes vão para a DLQ). Isso tira a mensagem do fluxo na hora, sem bloquear o grupo da wallet com reentregas inúteis, e a DLQ (14 dias) é a trilha de auditoria. A métrica de mensagens em DLQ (`wagering_sqs_queue_messages{queue="requests_dlq"}`, D44) alerta a operação. Alternativa descartada: ack + evento `WagerTransactionRequestRejected`, que criaria um evento fora do conjunto mínimo e não serviria para envelope ilegível. **Limitação:** o provedor não é avisado automaticamente de uma mensagem que foi para a DLQ.

### D31. Backoff e DLQ

| Opção de backoff | Resultado |
|---|---|
| **`ChangeMessageVisibility` exponencial (escolhida)** | espera = `min(SQS_RETRY_BASE_SECONDS × 2^(n−1), SQS_RETRY_MAX_SECONDS)`, com `n` = `ApproximateReceiveCount` (padrão 2 s × 2 com teto de 300 s, mesmo `backoffDelayMs` do domínio). Primeiras tentativas rápidas, sem estado local; se a chamada falhar, vale a visibilidade da fila (30 s) |
| Só o visibility timeout da fila | Lento para falhas de segundos e agressivo para quedas longas: com 5 × 30 s, uma queda de 3 min mandaria mensagens válidas para a DLQ |

**`maxReceiveCount` = 10:** 2+4+8+16+32+64+128+256+300 ≈ **13,5 min** de tolerância a falha transitória antes da DLQ. Com 5, uma queda de cerca de 30 s já mandaria mensagens válidas para a DLQ.

**DLQ híbrida:**
- erro permanente conhecido → `SendMessage` na DLQ e depois `DeleteMessage`, com o motivo;
- transitório e desconhecido → backoff até o `maxReceiveCount` mover. **O limite de tentativas é o da fila**, e vale também para crash e poison message.

Envio e delete não são atômicos: um crash entre os dois reenvia a mensagem, que é reclassificada e reenviada. A FIFO da DLQ descarta a duplicata em 5 min, porque o `MessageDeduplicationId` é o `messageId` original. Por isso o envelope limita o `messageId` a 128 caracteres, o limite do SQS para esse campo.

### D32. `MessageGroupId`, lote, paralelismo e o pool de conexões

**Contrato do produtor:**
- `MessageGroupId = walletId`;
- `MessageDeduplicationId = messageId`;
- corpo = o envelope `WagerTransactionRequested` do enunciado, seção 10 (`messageId` ≤ 128, `type: "WagerTransactionRequested"`, `occurredAt` ISO-8601, `data` com os campos do HTTP mais `idempotencyKey`);
- atributo opcional `correlationId`. Sem ele, `correlationId = messageId`.

O grupo é a unidade de concorrência do sistema: ordena por wallet e paraleliza entre wallets. Uma mensagem em backoff segura só o grupo dela (aquela wallet). **A correção não depende da FIFO** (inbox + idempotência + lock); outro group id só aumenta a disputa de lock.

**Lote:** até `SQS_MAX_MESSAGES` (10) por receive, com long polling de `SQS_WAIT_TIME_SECONDS` (20 s).
- As mensagens são agrupadas por `MessageGroupId`: **grupos em paralelo, sequência dentro do grupo**.
- Se uma mensagem do grupo falha transitoriamente, as seguintes do mesmo grupo no lote voltam com `ChangeMessageVisibility 0`, e a FIFO só as entrega de novo depois da que falhou. Verificado: BET e REFUND da mesma BET no mesmo lote saem ambos PROCESSED, sem PENDING_REFERENCE.

**Paralelismo limitado para não tirar conexões da API.**
- O consumer processa no máximo `SQS_CONSUMER_CONCURRENCY` mensagens ao mesmo tempo (`ConcurrencyLimit`, um semáforo com repasse direto da vaga). **Padrão: metade do `DB_POOL_MAX`**, com mínimo de 1.
- Cada mensagem usa **uma conexão por vez**: tudo roda numa transação, e a releitura de duplicata só acontece depois do rollback. Então o consumer nunca ocupa mais que `SQS_CONSUMER_CONCURRENCY` conexões, e o restante do pool fica para o HTTP.
- **A configuração valida** que o trabalho em segundo plano cabe no pool: consumer (se ligado) + publisher (1) + worker (1) < `DB_POOL_MAX`; senão a app não sobe (D40).
- Alternativa considerada: um pool de conexões separado para o consumer, que garantiria isolamento total, mas exigiria uma segunda instância do MikroORM e o dobro de conexões no Postgres. O limite por semáforo atinge o mesmo objetivo com um pool só.

### D33. Onde roda e shutdown

**Onde roda:** no mesmo processo da API, ligado por `SQS_CONSUMER_ENABLED` (`true` no `.env.example`, `false` no `.env.test`; os testes ligam por app). O health continua disponível. A separação de papéis entre instâncias é discutida em D52.

**Ciclo de vida:** o `WagerTransactionConsumer` é um provider Nest. Inicia em `onApplicationBootstrap` e drena em **`beforeApplicationShutdown`**, que roda antes do MikroORM fechar as conexões. Em SIGTERM (`enableShutdownHooks` → `app.close()`):
1. marca `stopping` e **aborta o long polling** em andamento (`AbortController` no `send` do SDK), sem esperar os 20 s;
2. mensagens do lote que ainda não começaram → `ChangeMessageVisibility 0`, voltando na hora para outra instância;
3. as que estão em andamento terminam e recebem ack, até `SQS_SHUTDOWN_GRACE_MS` (10 s);
4. passado o prazo, o shutdown segue e loga. Se o processo morrer antes do commit, o rollback e a reentrega cuidam; se depois, o inbox deduplica.

**Verificado:**
- SIGTERM durante um long polling de 20 s encerrou em 53 ms;
- com uma mensagem presa no lock da wallet, o `close()` esperou ela terminar, devolveu a seguinte do lote (visível de imediato, sem esperar os 30 s de visibilidade) e uma segunda instância a processou.

**Limitação:** um receive abortado no meio pode deixar mensagens invisíveis sem que o cliente as tenha recebido; elas voltam após a visibilidade da fila (30 s). Atrasa, mas não perde.

**Logs:** cada mensagem roda em `PinoLogger.runInContext` com `consumerName`, `sqsMessageId` e `receiveCount`, mais `messageId`, `correlationId`, `walletId` e `providerId` depois do parse (D47). O desfecho loga `transactionId`, status, `failureCode` e `idempotentReplay`. Não loga payload financeiro.

### D34. Testes do consumer

- Cada teste cria um par FIFO próprio (`wager-test-<uuid>.fifo` + DLQ), com visibilidade de 2 s e `maxReceiveCount` 3, e o apaga no fim. A app aponta para ele com long polling de 1 s e backoff de 1 s, para os cenários durarem segundos.
- Depois de cada teste: saldo de todas as wallets igual ao ledger, e fila principal e DLQ vazias.
- **Cobertos:** caminho feliz (inbox, ack, `causationId`), redelivery sem duplicar efeito, crash entre commit e ack (o teste confirma a transação pelo handler sem apagar a mensagem e só depois liga o consumer), transitório com retry até dar certo e transitório esgotado indo para a DLQ (provocados de verdade, travando a wallet por SQL até o lock timeout disparar), permanentes direto na DLQ com o código, mesmo `messageId` com outro payload, rejeição de negócio confirmada sem retry, ordem por grupo, lote com várias wallets e os dois cenários de shutdown.
- A espera por "o consumer está travado no lock da wallet" conta só esperas por lock de linha (`wait_event` `transactionid`/`tuple`). No `bun test --parallel`, arquivos de outros processos esperando o advisory lock de integração também aparecem como espera de lock e confundiam a contagem.
- **Timeout dos testes:** o `bunfig.toml` não tem opção de timeout de teste; uma chave desconhecida é ignorada em silêncio e vale o padrão de 5 s. Por isso o `useIntegrationEnvironment()` chama `setDefaultTimeout`, que vale para o arquivo corrente; a chamada fica no helper que todo arquivo de integração já usa, e não no preload.

## 10. Publisher do outbox e worker de PENDING_REFERENCE

A publicação dos eventos do outbox (enunciado, seção 11: vários publishers concorrentes, sem perder nem duplicar indefinidamente) e o reprocessamento das transações em PENDING_REFERENCE (enunciado, seção 7.1), os dois no processo da API (D40).

### D35. Destino dos eventos e contrato

| Opção | Resultado |
|---|---|
| **Fila SQS FIFO `wager-events.fifo` (escolhida)** | Mesma infra; ordem por grupo; deduplicação nativa de 5 min; contrato simples para o consumidor; testável com receive |
| Tópico SNS FIFO + filas SQS FIFO assinantes | Fan-out mantendo ordem e dedup, mas mais um serviço no LocalStack, com assinaturas para configurar e testar, e hoje nenhum consumidor pede fan-out |
| EventBridge / Kinesis | Roteamento e replay muito além da necessidade |

**Mensagem publicada** (`SqsEventPublisher`):
- **corpo:** o `payload` do outbox, que é o envelope de `IntegrationEvent.toJSON()` (`eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId` opcional, `occurredAt`, `version`, `data`);
- **`MessageGroupId`:** `ordering_key` do outbox, que é o `walletId` (a unidade de ordem, D36);
- **`MessageDeduplicationId`:** `eventId`, que é também o id da linha do outbox;
- **atributos:** `eventType`, `eventId`, `aggregateId`, `correlationId` e `version`, para filtrar e rastrear sem abrir o corpo.

**Contrato do consumidor:** deduplicar por `eventId` (D37) e processar em ordem por grupo. A fila não tem DLQ própria e guarda as mensagens por 14 dias: retry e DLQ são responsabilidade de quem consome, que ainda não existe neste repositório. Evoluir para SNS FIFO fica para quando houver mais de um consumidor; o publisher só troca o `SendMessage` por `Publish`.

### D36. Divisão do trabalho entre publishers e ordem por wallet

**Divisão: `FOR UPDATE SKIP LOCKED` com a transação aberta durante o envio.**

| Opção | Resultado |
|---|---|
| **SKIP LOCKED segurando a transação (escolhida)** | Nenhuma coluna de reserva; se o processo morre, a conexão cai, o Postgres desfaz e as linhas ficam livres **na hora** para outra instância; uma conexão por publisher; as linhas travadas não bloqueiam o caminho de negócio, que só faz INSERT no outbox |
| Reserva com prazo (`locked_until`, `locked_by`) | Transação curta, mas duas colunas, guard e migration a mais; depois de um crash, a retomada espera o prazo vencer; prazo curto demais publica em dobro enquanto o primeiro ainda está lento |
| Um publisher ativo por vez (advisory lock de liderança) | Ordem trivial, mas sem paralelismo: "funciona com vários publishers" só no sentido de ficarem parados |

O custo é a transação aberta durante a chamada de rede. Ele é limitado pelo timeout de cada envio (`OUTBOX_PUBLISH_TIMEOUT_MS`, 5 s, via `AbortSignal` no SDK) e pelo tamanho do lote.

**Ordem estrita por wallet.** Com SKIP LOCKED puro, dois publishers poderiam pegar eventos diferentes da mesma wallet e publicá-los fora de ordem, por exemplo um `WagerTransactionProcessed` antes do `WagerTransactionPendingReference` da mesma transação. A sétima migration acrescenta ao outbox:
- **`ordering_key`** (`walletId`, vindo de `IntegrationEvent.orderingKey`, que cada subclasse preenche);
- **`position bigint GENERATED ALWAYS AS IDENTITY`**. Os eventos de uma wallet são gravados com o lock dela, então a ordem de `position` dentro de uma wallet é a ordem de commit, sem depender de relógio;
- o índice parcial `outbox_messages_pending_by_ordering_key (ordering_key, position) WHERE published_at IS NULL`.

Os dois campos entram na lista de colunas imutáveis do guard do outbox, e o backfill das linhas existentes desliga o guard só durante o próprio UPDATE.

**Reivindicação em dois passos, na mesma transação** (`MikroOrmOutboxRepository.claimDue`, com o query builder Kysely do MikroORM ligado à transação corrente, sem SQL cru):
1. trava com `SKIP LOCKED` as **cabeças**: o evento pendente mais antigo de cada wallet (`NOT EXISTS` de pendente anterior com a mesma chave) que já venceu, até `OUTBOX_BATCH_WALLETS` (20) wallets;
2. para essas wallets, trava os pendentes seguintes em ordem de `position` e aproveita os que já venceram até o primeiro que não venceu, no máximo `OUTBOX_BATCH_EVENTS_PER_WALLET` (50).

Quem detém a cabeça é dono da wallet naquele ciclo; os outros publishers não pegam eventos dela, porque não são cabeça. O passo 2 não usa SKIP LOCKED, e não precisa: só o dono da cabeça chega a essas linhas.

**Ciclo do publisher** (`PublishPendingEvents.runOnce`): reivindica, publica **wallets em paralelo e eventos da mesma wallet em sequência**, marca cada um (`markPublished` ou `scheduleRetry`, com o backoff de D15) e grava tudo no mesmo COMMIT. Numa falha, os eventos seguintes da mesma wallet ficam para depois do retry dela, a mesma semântica do grupo FIFO. Se o ciclo publicou algo, roda de novo na hora; senão, espera `OUTBOX_POLL_INTERVAL_MS` (500 ms).

**Medido** (dois publishers, 150 eventos em 25 wallets, lote reduzido a 5 wallets × 2 eventos para forçar disputa): divisão de 70 + 80 envios, **150 envios no total** (nenhum evento enviado duas vezes), ordem por wallet igual à de `position`, zero duplicatas na fila.

### D37. Morte do processo e duplicatas

- **Morreu depois do commit de negócio e antes de publicar:** o evento está pendente no outbox, confirmado junto com o efeito, e o publisher de qualquer instância o publica. Nada se perde.
- **Morreu depois de o SQS aceitar e antes de marcar:** a transação do publisher é desfeita, o evento volta a pendente e é **publicado de novo**.
  - **Dentro de 5 min**, a FIFO descarta a duplicata pelo `MessageDeduplicationId = eventId`.
  - **Depois disso**, a duplicata chega, e é segura porque o contrato do consumidor é deduplicar por `eventId` (o mesmo padrão de inbox da entrada, D29).
- **"Sem duplicar indefinidamente":** um evento só é republicado enquanto não for marcado. Marcado, nunca mais é reivindicado, porque o guard grava `published_at` uma vez e impede voltar.
- **Verificado:** com um trigger temporário fazendo falhar o UPDATE que marca `published_at`, o publisher enviou 4 eventos 4 vezes (16 envios) antes de o trigger sair. A fila entregou cada um **uma vez**.

### D38. Worker de PENDING_REFERENCE, empurrão e eventos

**Regra de negócio num lugar só.** O trecho "resolver a referência → `referenceAlreadyReversed` → `settleWagerTransaction` → gravar transação, lançamento, wallet e outbox → empurrão" fica no `SettleAndRecord`. A submissão o chama com a transação nova (INSERT); o worker, com a existente (UPDATE de campos mutáveis, que o guard de `wager_transactions` limita).

**Ciclo do worker** (`RetryPendingReferences.runOnce`):
1. lista até `REFERENCE_WORKER_BATCH` (50) transações vencidas (`status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= now`, índice `wager_transactions_pending_reference_due`);
2. para cada uma, em sequência e em transação própria: **trava a wallet** (o mesmo lock da submissão HTTP e do consumer), **relê a transação sob o lock**, pula se ela não está mais pendente ou ainda não venceu, e chama o `SettleAndRecord`. O domínio decide: PROCESSED, REJECTED (inclusive por limite esgotado, D12.1) ou nova tentativa com backoff;
3. com lote cheio e sem falhas, roda de novo na hora; senão, espera `REFERENCE_WORKER_POLL_INTERVAL_MS` (1 s).

**Concorrência:**
- com HTTP ou consumer na mesma wallet, o lock serializa. A transação pendente só é alterada pelo worker;
- com dois workers, os dois podem listar o mesmo id, mas o segundo, depois de pegar o lock, relê e encontra a transação resolvida ou reagendada, e pula. O índice de reversão única (D17) e o guard de estado terminal são as últimas barreiras.

**Empurrão.** Quando uma transação chega a um desfecho **terminal** (PROCESSED ou REJECTED), o `SettleAndRecord` reagenda para aquele instante as dependentes que esperam por ela:

```
UPDATE wager_transactions SET next_reference_attempt_at = :at
 WHERE status = 'PENDING_REFERENCE' AND provider_id = :providerId
   AND reference_external_transaction_id = :externalTransactionId AND next_reference_attempt_at > :at
```

É um `nativeUpdate`, permitido pelo guard (linha não terminal, payload intacto, tentativas iguais), com o índice parcial `wager_transactions_waiting_for_reference`. A dependente fica vencida logo após o commit, e o worker a resolve no próximo ciclo (≤ 1 s) em vez de esperar o backoff (até 60 s). Vale também para REJECTED, porque a dependente pode ser rejeitada com `REFERENCE_NOT_PROCESSED` sem esperar. É só reagendamento: quem decide continua sendo o domínio. Verificado: uma dependente com a próxima tentativa empurrada por SQL para daqui a 1 h foi resolvida logo depois que a referência chegou (o teste exige menos de 5 s).

**`WagerTransactionPendingReference` só na primeira vez**, na transição PENDING → PENDING_REFERENCE. As novas tentativas não mudam o estado; o progresso aparece em `referenceAttempts` e `nextReferenceAttemptAt` no GET. Quando a transação sai do estado, sai `WagerTransactionProcessed` (mais `WalletBalanceChanged`, se houver lançamento) ou `WagerTransactionRejected`.

**Replay:** reenviar a submissão depois que o worker a resolveu devolve o estado final. Um REFUND que voltou 202 passa a voltar 200 PROCESSED com `idempotentReplay: true` e o saldo observado na resolução.

**Limite esgotado testado por "viagem no tempo".** O teste grava `reference_attempts = 8` e vencimento imediato por SQL (o guard aceita, porque as tentativas só sobem). A política continua sendo constante de domínio (D12.1), e o teste não espera os ~3 min reais.

### D39. `correlation_id` persistido na transação

O worker resolve transações sem uma requisição em curso, às vezes minutos depois e em outro processo. Para que o rastreio vá **da requisição até o evento final**, o `correlationId` original fica gravado na transação. Usar o id da transação como `correlationId` dos eventos do worker, a alternativa mais simples, quebraria esse rastreio.
- A sétima migration acrescenta `wager_transactions.correlation_id text NOT NULL`, com `CHECK (length BETWEEN 1 AND 128)` (`wager_transactions_correlation_id_bounds`). As linhas anteriores recebem o próprio id da transação no backfill.
- É gravado na criação (`WagerTransaction.create` e `WagerTransaction.opening` exigem o campo) e **entra na lista de colunas imutáveis do guard** (`wager_transactions_payload_immutable`).
- Todos os eventos da transação, os da submissão e os do worker, usam `transaction.correlationId`. O `causationId` continua sendo o `messageId` quando a origem é o SQS, e fica ausente nos eventos do worker, que não têm mensagem de origem.
- **De onde vem o valor:** no HTTP, o header `x-correlation-id` quando aceito (`^[A-Za-z0-9._:-]{1,128}$`) ou um UUID gerado; no SQS, o atributo `correlationId` com a **mesma regra**, ou o `messageId`. A regra fica em `infrastructure/observability/correlation-id.ts` e vale para as duas entradas; sem ela, um atributo com mais de 128 caracteres violaria o CHECK.
- **Verificado:** um REFUND enviado com `x-correlation-id: manual-refund-2` antes da BET publicou `PendingReference`, `Processed` e `WalletBalanceChanged` com esse `correlationId`, os dois últimos emitidos pelo worker.

### D40. Onde rodam, shutdown e o pool

- **Onde rodam:** no processo da API, ligados por `OUTBOX_PUBLISHER_ENABLED` e `REFERENCE_WORKER_ENABLED` (`true` no `.env.example`, `false` no `.env.test`; os testes ligam por app). São providers Nest em `src/interfaces/workers`, com o ciclo de vida do consumer (D33).
- **`PollingLoop`:** o laço comum aos dois. Roda um ciclo; se o ciclo diz que há mais trabalho, roda de novo; senão, espera o intervalo numa espera que o shutdown interrompe. Um erro no ciclo é logado e vira espera, sem derrubar o laço.
- **Shutdown** (`beforeApplicationShutdown`): para o laço, interrompe a espera na hora e deixa o ciclo em andamento terminar, até `WORKER_SHUTDOWN_GRACE_MS` (10 s). O publisher termina dentro do teto dos envios; o worker termina a transação corrente. Passado o prazo, o shutdown segue, e o rollback ao fechar a conexão devolve o trabalho para outra instância. Verificado com SIGTERM em `bun run start`: worker, publisher e consumer pararam, sem erro no log.
- **Pool (com D32):** o publisher usa 1 conexão por ciclo e o worker 1, porque processa em sequência. A validação exige `consumer (se ligado) + publisher (1, se ligado) + worker (1, se ligado) < DB_POOL_MAX`, senão a app não sobe. Com o padrão de 10: 5 + 1 + 1 = 7, e sobram 3 para o HTTP.
- **Logs:** cada ciclo roda com `worker` no contexto do pino. O publisher loga uma linha por evento publicado e cada falha; o worker loga cada transação avaliada e cada falha (campos em D47).

### D41. Testes do publisher e do worker

- **Publisher** (`test/integration/workers/outbox-publisher.test.ts`): cada teste cria uma fila de eventos própria (`wager-events-test-<uuid>.fifo`) e, antes, marca como publicados os eventos que os testes anteriores deixaram no outbox. Os envios são contados por um spy que embrulha o `EventPublisher` real, sem substituí-lo.
  - dois publishers sobre o mesmo outbox (ordem por wallet, nenhum envio a mais, nenhuma duplicata);
  - instância morta antes de publicar;
  - envio sem marcação, provocado por um trigger temporário (D37);
  - falha de publicação com retry: a fila ainda não existe, o evento entra em backoff e os seguintes da wallet esperam; depois de a fila ser criada, sai tudo em ordem;
  - evento do meio em backoff segurando os seguintes da wallet sem atrasar as outras.
- **Worker** (`test/integration/workers/pending-reference-worker.test.ts`): REFUND antes da BET (com o `correlationId` original nos eventos), ROLLBACK antes do WIN (DEBIT), empurrão de uma dependente com backoff de 1 h, novas tentativas sem a referência (backoff exato e nenhum evento novo), limite esgotado (REJECTED `REFERENCE_NOT_FOUND`, evento e replay 422), replay depois da resolução, worker e 20 BETs HTTP simultâneas na mesma wallet, e dois workers sobre as mesmas 10 dependentes.
- Depois de cada teste, o saldo de todas as wallets é conferido contra o ledger.

## 11. Reconciliação, métricas e logs

O endpoint de reconciliação (enunciado, seção 9: comparar o saldo gravado com o reconstruído pelo ledger; divergência logada, contabilizada e sinalizada, nunca corrigida), as métricas e os logs (enunciado, seção 12: logs estruturados com os identificadores e sem dado sensível; métricas de transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência).

### D42. Reconciliação sem bloquear escritas

**Contrato** (o formato do enunciado, sem campos extras): `POST /wallets/:walletId/reconciliation`, sem corpo, atrás do `AuthGuard` como as outras rotas de wallet.
- **`calculatedBalance`:** Σ CREDIT − Σ DEBIT de todos os lançamentos da wallet, inclusive o OPENING.
- **`difference`:** `storedBalance − calculatedBalance`. Positivo significa saldo sem lastro no ledger.
- **`checkedEntries`:** quantos lançamentos foram somados.

**Resposta:**
- **Sempre 200**, com `consistent: true` ou `false`: a verificação funcionou, e a divergência é o dado que ela devolve.
- **404 `WALLET_NOT_FOUND`** e **400 `VALIDATION_FAILED`** como nas outras rotas.
- **Divergência:** a resposta a sinaliza, um log `error` a registra (D47), `wagering_reconciliations_total{result="inconsistent"}` a conta, e **nada é corrigido**.

**Camadas:**
- **`WalletReconciliation`** (domínio): value object com `compare(...)`, que calcula `difference` e `consistent` e recusa moedas diferentes.
- **`WalletLedgerRepository.summarize(walletId, currency)`** (porta): a soma roda no Postgres, em `numeric` (exato), sem trazer o ledger para a memória. O adaptador usa o Kysely tipado do MikroORM, sem SQL cru, e aceita soma negativa, que só um ledger corrompido produz.
- **`ReconcileWallet`** (aplicação): lê a wallet e a soma dentro de `TransactionRunner.readSnapshot`.

**Leitura consistente:**

| Opção | Resultado |
|---|---|
| **`REPEATABLE READ READ ONLY` (escolhida)** | Saldo e soma vêm do mesmo snapshot MVCC; nada é travado, então as escritas seguem e a reconciliação não espera lock; a intenção fica explícita (`readSnapshot` → `em.transactional(work, { isolationLevel: REPEATABLE_READ, readOnly: true })`). Por ser só leitura, nunca recebe erro de serialização |
| Uma instrução só (JOIN + agregado) em READ COMMITTED | Também é um snapshot só, mas a garantia fica implícita: separar a consulta em duas quebra a consistência sem que ninguém perceba |
| Travar a wallet (`FOR SHARE`/`FOR UPDATE`) | Bloqueia as escritas durante a soma; numa wallet quente, gera 503 |
| Corte por versão (`wallet_version <= versão lida`) | Esconde justamente a corrupção "lançamento além da versão da wallet" |

O `findById` da wallet usa `refresh: true`, para que o identity map não devolva uma wallet lida antes do snapshot.

**Verificado:**
- **Teste determinístico** (`test/integration/application/reconcile-wallet.test.ts`): uma subclasse do repositório real confirma uma BET por HTTP entre a leitura da wallet e a soma. Com `REPEATABLE READ`, a reconciliação vê 100.00 dos dois lados. Trocando por READ COMMITTED, o mesmo teste acusa uma **divergência falsa de 10.00**.
- **Escrita em andamento:** com outra sessão segurando a wallet com um UPDATE não confirmado, a reconciliação respondeu em menos de 1 s com o estado confirmado.
- **Teste HTTP concorrente** (20 BETs e 20 reconciliações em paralelo, todas consistentes): continua na suíte como fumaça, mas **não discrimina** o nível de isolamento, porque também passou com READ COMMITTED; a janela entre as duas leituras é curta demais. A prova é o teste determinístico.

**Como o teste cria a divergência:** os triggers de coerência (D17) impedem uma divergência por qualquer caminho normal.

| Opção | Resultado |
|---|---|
| **`SET LOCAL session_replication_role = replica` + `UPDATE wallets` (escolhida)** | Desliga os triggers **só naquela transação da sessão de teste**, sem DDL e sem afetar outras conexões; exercita o endpoint, o log e a métrica reais. Exige superusuário, que é o usuário do container (`rolsuper = t`). O teste restaura o saldo do mesmo jeito num `finally` |
| `ALTER TABLE … DISABLE TRIGGER` | DDL com `ACCESS EXCLUSIVE`, vale para todas as sessões enquanto dura |
| Repositório falso | É mock no lugar do Postgres |

É ferramenta de teste e de diagnóstico manual; a aplicação nunca faz isso.

### D43. Métricas: biblioteca, formato e catálogo

| Opção | Resultado |
|---|---|
| **`prom-client` 15.1.3, formato de exposição do Prometheus em `GET /metrics` (escolhida)** | Padrão de fato; Counter, Gauge e Histogram prontos; texto que Prometheus, Grafana Agent e OTel Collector leem. As métricas padrão de processo (CPU, memória, event loop, heap) **funcionam no Bun 1.4.2** (verificado) e estão incluídas |
| `@willsoto/nestjs-prometheus` | Mais uma dependência por um controller pequeno |
| SDK de métricas do OpenTelemetry | Várias dependências e compatibilidade incerta com o Bun, além do pedido |

**Desenho:**
- **Um `Registry` por instância da app** (provider do `MetricsModule`), e não o registro global do `prom-client`. Os testes sobem várias apps no mesmo processo, e o registro global daria "metric already registered".
- **`WageringMetrics`** concentra os contadores e histogramas, com métodos semânticos.
- **Domínio e aplicação não conhecem métricas.** Quem registra é a borda (controllers, consumer, workers), a partir do resultado que os casos de uso já devolvem, sempre depois do COMMIT. As exceções, ambas em adaptadores, são o conflito de lock (D45) e a espera do lock da wallet.
- **Rótulos só de conjuntos fechados, nunca ids**, o que evita cardinalidade explosiva e dado identificável na métrica.

| Métrica | Tipo | Rótulos | O que mede |
|---|---|---|---|
| `wagering_transactions_total` | counter | `source` (http, sqs, worker), `kind`, `status`, `failure_code` (`none` se não rejeitada) | Transações que **entraram** num status, inclusive o OPENING. Replays não contam; a nova tentativa do worker que continua pendente vai para retries |
| `wagering_duplicates_total` | counter | `source`, `type` (`idempotent_replay`, `inbox`) | Replays idempotentes (inclusive pelo caminho da unique) e duplicatas do inbox |
| `wagering_retries_total` | counter | `component` (`sqs_consumer`, `outbox_publisher`, `reference_worker`), `reason` | Retry agendado pelo consumer (código da falha), cada `scheduleRetry` do publisher (`PUBLISH_FAILED`) e reavaliação sem referência (`REFERENCE_MISSING`); falhas de ciclo como `DEPENDENCY_UNAVAILABLE`/`UNEXPECTED_ERROR` |
| `wagering_dead_lettered_total` | counter | `code` | Mensagens que o consumer mandou explicitamente para a DLQ |
| `wagering_lock_conflicts_total` | counter | `type` (`timeout`, `deadlock`) | D45 |
| `wagering_reconciliations_total` | counter | `result` | Cada reconciliação |
| `wagering_metrics_probe_failures_total` | counter | `probe` (`outbox`, `pending_references`, `sqs`) | Sonda do scrape que falhou ou estourou o tempo (D44) |
| `wagering_processing_duration_seconds` | histogram | `source`, `result` | **Latência de processamento:** o caso de uso no HTTP; do recebimento ao ack, retry ou DLQ no consumer; cada liquidação no worker. `result`: status final, `REPLAY`, `DUPLICATE`, `RETRY`, `DEAD_LETTER` ou `ERROR` |
| `wagering_outbox_publication_delay_seconds` | histogram | — | `published_at − occurred_at` de cada evento |
| `wagering_wallet_lock_wait_seconds` | histogram | — | Duração do `SELECT … FOR UPDATE` da wallet: contenção **antes** de virar timeout |
| `wagering_outbox_pending_events` | gauge | — | Eventos pendentes no outbox (D44) |
| `wagering_outbox_oldest_pending_age_seconds` | gauge | — | **Outbox lag:** idade do pendente mais antigo, 0 quando vazio (D44) |
| `wagering_pending_reference_transactions` | gauge | — | Backlog do worker de PENDING_REFERENCE |
| `wagering_sqs_queue_messages` | gauge | `queue` (`requests`, `requests_dlq`, `events`), `state` (`visible`, `in_flight`) | Profundidade das filas; **`queue="requests_dlq"` é a métrica de mensagens em DLQ** (D44) |

**Várias instâncias:** cada uma expõe os próprios contadores e histogramas (somar com `sum`/`rate`), e os gauges consultados no banco ou no SQS saem iguais em todas (agregar com `max`). Contadores voltam a zero no restart do processo, o que o `rate()` do Prometheus já trata.

### D44. Outbox lag e DLQ medidos no scrape

| Opção | Resultado |
|---|---|
| **Consultar no scrape, com timeout por sonda (escolhida)** | Valor sempre atual; nenhum laço nem conexão extra além do request do scrape; consultas baratas (índice parcial dos pendentes do outbox e de PENDING_REFERENCE, `GetQueueAttributes`) |
| Amostrador em segundo plano | Mais um laço e uma conexão (entraria na conta do pool, D40), com valor até N s velho |
| Só o histograma de atraso de publicação | Com o publisher parado, nada é publicado e o histograma fica quieto, justamente quando mais importa alarmar. Ele complementa o gauge, mas não o substitui |

**Mecanismo:** o `MetricsController` chama `BacklogGauges.refresh()` e só depois serializa o registro.
- `refresh()` roda em paralelo uma consulta ao outbox (`count(*)` e `min(occurred_at)` dos pendentes), a contagem de PENDING_REFERENCE e um `GetQueueAttributes` por fila, cada sonda limitada por `HEALTH_CHECK_TIMEOUT_MS`.
- **Por que não o `collect()` assíncrono dos gauges:** o `prom-client` lê os contadores antes de os `collect()` terminarem, então a falha de uma sonda só apareceria no scrape seguinte. Com o `refresh()` explícito, a ordem é determinística, e os dois gauges do outbox saem de uma única consulta.
- **Numa falha:** o gauge da sonda vira **`NaN`**, `wagering_metrics_probe_failures_total{probe}` sobe, um `warn` vai para o log e o resto do `/metrics` responde normalmente. `NaN`, e não 0, porque o `reset()` de um gauge sem rótulos do `prom-client` volta a 0, e isso diria "lag zero" exatamente quando a medida falhou.

**DLQ:**
- o gauge `requests_dlq` conta tudo o que está na DLQ, inclusive o que o SQS moveu pelo `maxReceiveCount`, que a app não vê;
- `wagering_dead_lettered_total{code}` conta os envios explícitos do consumer, por motivo.

`ApproximateNumberOfMessages` é aproximado na AWS real (no LocalStack é exato).

### D45. O que conta como conflito de lock

**Conflito = transação SQL que falhou por `55P03 lock_not_available` (timeout de D26) ou `40P01 deadlock`.**
- **Onde conta:** uma vez por erro, no `MikroOrmTransactionRunner.run`. É um ponto só, que cobre HTTP, consumer, worker e o que vier.
- **Contagem única:** a transação aninhada (savepoint, D29) propaga o mesmo erro para a externa, e um `WeakSet` de erros já contados evita contar duas vezes. **Verificado:** no teste do consumer, o aumento de conflitos é igual ao de retries `DEPENDENCY_UNAVAILABLE`.
- **Contenção abaixo do timeout:** aparece no histograma `wagering_wallet_lock_wait_seconds`, medido no `findByIdForUpdate`.

**Não contam:**
- a corrida resolvida pela unique (é duplicata, em `wagering_duplicates_total`);
- a linha pulada pelo `SKIP LOCKED` do publisher (é a divisão do trabalho);
- a disputa na PK do inbox (é duplicata).

**Deadlock cru:** as consultas Kysely (a reivindicação do outbox, a soma da reconciliação) entregam o erro do `pg` sem a conversão do MikroORM para `DeadlockException`. Por isso `isTransientDatabaseError` reconhece também o código `40P01` (`test/unit/infrastructure/transient-error.test.ts`).

### D46. `/metrics` aberto

| Opção | Resultado |
|---|---|
| **Aberto como o health (escolhida)** | O Prometheus faz scrape sem credencial; o conteúdo é operacional (contagens, latências, profundidades), sem id, saldo nem dado de jogador. Fica fora do log automático de request, como `/health` |
| Atrás do `AuthGuard` | Hoje o guard é no-op. Com autenticação real (seção 13), o scraper precisaria de um client e de um escopo próprios |
| Porta separada | Um segundo servidor HTTP no processo |

Em produção, a rota não sai pelo ingress público (rede interna ou allowlist). Quem alcança a porta vê volume e taxa de erro.

### D47. Logs: campos por caminho e a regra de saldo

**Campos por caminho** (os identificadores pedidos pelo enunciado, seção 12; `messageId` só existe no SQS):

| Caminho | Campos |
|---|---|
| HTTP | `correlationId` sempre; `walletId`, `providerId` e `transactionId` quando a rota os tem. Vão via `PinoLogger.assign` nos controllers, com `assignResponse: true`, para que a linha `request completed` (ou `request errored`, nas respostas 5xx) e os logs do filtro de erros os levem |
| Consumer | `correlationId`, `messageId`, `walletId` e `providerId` no contexto logo após o parse (retry e DLQ também os levam); `transactionId` no desfecho |
| Publisher | Uma linha `info` por evento publicado: `eventId`, `eventType`, `walletId`, `correlationId` do evento, `transactionId` e `providerId` lidos do envelope (nunca o `data` inteiro) e `delayMs`. Os mesmos campos na falha |
| Worker | `correlationId` persistido (D39), `transactionId`, `walletId`, `providerId`, status e tentativas |
| `PollingLoop` | O ciclo **e o log de erro do ciclo** rodam dentro do contexto do pino, com `worker` |

**Regra única: saldos não entram em log.**
- **Chamadas de log:** nunca recebem `storedBalance`, `calculatedBalance`, `balanceBefore`/`After` nem o `money` de um payload. O log de divergência leva só `walletId`, `difference` e `checkedEntries`. A `difference` é a única quantia logada, porque mede o erro sem revelar o saldo. Os valores completos ficam na resposta do endpoint.
- **Erros:** o serializer de `err` é allowlist (`type`, `message`, `code`, `constraint`, `stack`). Ele descarta `detail`, `where`, `parameters` e o resto que o `DriverException` copia do `pg`: o `detail` de um CHECK traz a linha inteira, e o dos triggers traz saldos.
- **Mensagens e stacks de erro:** passam por uma máscara de valores monetários (`-?\b\d+\.\d{2}\b` → `[amount]`), porque as mensagens dos triggers de coerência e de algumas invariantes citam saldos. Ids, versões, horários e posições de código não casam com o padrão (teste unitário).
- **Requisição e resposta:** continuam em allowlist (D5).
- **`playerId`:** aparece só no `warn` de `WALLET_PLAYER_MISMATCH`, a trilha de auditoria da D28.

**Armadilhas do nestjs-pino:**
- **`assign` cria um logger filho, e o pino acrescenta os bindings em vez de substituí-los.** Atribuir a mesma chave duas vezes duplicaria o campo na linha; por isso cada campo é atribuído uma vez, os logs não repetem campos que já estão no contexto, e o teste acusa chave duplicada em qualquer linha.
- **O nestjs-pino 5 mantém um único middleware pino-http por processo** (estado de módulo), criado pela primeira app. Em produção há uma app por processo, então não muda nada. Nos testes, todas as apps escrevem num destino comum (`testLogSink`, repassado ao stdout), a captura se inscreve nele, e o nível é ajustado em tempo de execução pelo `PinoLogger.root`, o ponto que a própria biblioteca expõe para isso. O reset de testes da biblioteca não é exportado pelo pacote.
- `createApp(config, { logDestination })` é a costura no composition root; o logger continua sendo o real.

**Teste com canários** (`test/integration/observability/logs.test.ts`): uma app com consumer, publisher e worker ligados, valores distintivos (saldo de abertura 4321.09, `amount` 987.65, `gameId` e `roundId` únicos) passando por HTTP, SQS, worker e publisher, mais um 503 por lock. O teste verifica:
- os campos de cada caminho;
- que nenhum canário aparece em nenhuma linha;
- que nenhuma linha tem chave proibida (`money`, `amount`, `balance`, `payload`, `body`, `headers`, `playerId`, `detail`);
- que nenhuma linha tem chave duplicada.

## 12. Múltiplas instâncias, falhas de processo e empacotamento

Testes com processos reais da aplicação (enunciado, seção 13: ≥ 3 processos simultâneos, worker morto depois do commit e antes do ack, dois publishers sobre a mesma outbox, reinício com comprovação da consistência final), a imagem Docker e as réplicas no compose.

### D48. Testes com processos reais

| Opção | Resultado |
|---|---|
| **Processos do host com `Bun.spawn([bun, "src/main.ts"])` (escolhida)** | O mesmo entrypoint da produção; 3 processos ficam prontos em ~0,7 s; `kill -9` e SIGTERM exatos por PID; env e porta por processo; nada para buildar |
| Réplicas do compose (`docker kill`) | Exercita a imagem, mas o build e a subida são lentos, o env por teste é difícil, e o proxy de falhas (D49) precisaria rodar dentro da rede do compose |

**`test/support/app-process.ts`:**
- **`AppProcess.start(nome, env)`:**
  - **Porta:** uma porta livre (`Bun.listen` na 0, lê e fecha).
  - **Env:** o do runner (`.env` + `.env.test`, banco `wagering_test`) mais as sobrescritas do cenário: `DB_POOL_MAX=6`, long polling de 1 s, polls de 100 ms, backoff de 1 s, filas do teste e as flags de cada laço.
  - **Logs:** stdout em `$TMPDIR/wagering-multiprocess/<execução>/<nome>-<porta>.log`.
- **Readiness:** `GET /health/ready` = 200, com limite de 20 s. O consumer e os workers começam no `onApplicationBootstrap`, antes do `listen`, então "pronto" já é "laços rodando". Se o processo morre antes, o erro traz o final do log.
- **Encerramento:** `terminate()` (SIGTERM, com limite de 25 s antes de SIGKILL e falha) e `kill()` (SIGKILL). As duas devolvem o código ou o sinal de saída.
- **Encerramento garantido:**
  - o `afterEach`/`afterAll` faz `AppProcess.stopAll()` (SIGKILL em todos e espera a saída);
  - um `process.once("exit")` no runner mata o que sobrar;
  - toda espera tem limite, e o erro anexa o final dos logs;
  - cada teste usa filas e portas próprias, então um órfão não contamina a execução seguinte;
  - os filhos levam o marcador `--wagering-test-instance` na linha de comando (a app ignora `argv`), para que `pkill -f -- --wagering-test-instance` encerre só eles, e não um `bun run dev` nem as réplicas do compose, que também aparecem no `ps` do host.
- **Observação de fora:** os testes leem o `/metrics` **de cada processo** (quem processou, quantas duplicatas, quantas publicações) e o arquivo de log dele.
- **`FleetClient`:** distribui as requisições entre os processos vivos e, em erro de conexão ou 503, reenvia a **mesma** requisição (mesma `Idempotency-Key`) para outro processo, como um provedor faria.

**Cenários** (`test/multiprocess/`, 10 testes):

| Arquivo | Cenários |
|---|---|
| `http-instances` | A mesma aposta 50× espalhada entre 3 processos (um débito; 49 replays somados das métricas de ≥ 2 processos); as duas apostas de 80.00 sobre 100.00 (enunciado, seção 8) divididas entre processos, em 20 wallets, com reenvio para o terceiro; 10 wallets × 30 BETs espalhadas (100 por processo, saldos exatos) |
| `messaging-instances` | Consumers de 3 processos na mesma fila (150 mensagens, reentregas e mesma chave com outro `messageId`; ≥ 2 processos consumiram); publishers de 2 processos (150 eventos, ordem por wallet, envios somados = eventos, divisão medida 72/78 e 76/74); publisher morto depois do aceite do SQS |
| `process-failures` | `kill -9` entre o commit e o ack; `kill -9` antes do commit; SIGTERM real com mensagem em andamento |
| `restart-consistency` | D50 |

### D49. Proxy de falhas e a janela entre o commit e o ack

Depois do COMMIT, o consumer só faz trabalho em memória (métrica, log) e chama `DeleteMessage`. Não há acesso ao banco nessa janela, que dura milissegundos.

| Opção | Resultado |
|---|---|
| **Proxy SQS de teste entre o processo e o LocalStack (escolhida)** | O processo roda o binário de produção sem alteração (só `SQS_ENDPOINT` aponta para o proxy) e é determinístico. Nenhum gancho no código de produção |
| Entrypoint de teste que embrulha o `SqsQueueGateway.delete` | Determinístico, mas o processo morto não é o binário de produção |
| Observar o inbox e mandar `kill -9`/SIGSTOP | Corrida de milissegundos; não determinístico |
| Variável de ambiente na app (`ACK_DELAY_MS`) | Gancho em produção que poderia ser ativado por engano |
| Chaos API do LocalStack | Só na versão Pro |

**Proxy** (`test/support/sqs-fault-proxy.ts`): `Bun.serve` numa porta livre, que encaminha método, headers e corpo ao LocalStack.
- O SDK v3 do SQS usa protocolo JSON, com a operação em `X-Amz-Target: AmazonSQS.<Operação>`.
- Como o `SQSClient` da app tem `endpoint` explícito, o SDK nunca troca o host pelo da QueueUrl (o `queueUrlMiddleware` só age sem `endpoint`), então nenhuma chamada contorna o proxy.
- Na resposta, o proxy descarta `content-encoding` e `content-length`, porque o `fetch` já descompactou o corpo.
- Duas regras, armadas pelo teste:
  - **`holdBeforeForwarding("DeleteMessage")`:** não encaminha nem responde, e avisa o teste. O LocalStack nunca recebe o ack.
  - **`holdAfterForwarding("SendMessage")`:** encaminha e retém a resposta. É o "SQS aceitou e o processo morreu antes de marcar `published_at`".

**Morte entre o commit e o ack:**
1. Só o processo A roda, com o consumer apontado para o proxy.
2. O teste espera o proxy reter o `DeleteMessage` de M. Nesse instante, o inbox de M já existe (COMMIT feito) e M está **em voo** na fila (`inFlight: 1`).
3. `kill -9` em A.
4. B sobe com o SQS direto, recebe M depois da visibilidade (2 s), o inbox acusa duplicata e B dá ack.

**Provado:** uma linha de inbox, um lançamento, saldo exato, `wagering_duplicates_total{type="inbox"}` = 1 e nenhuma transação nova no `/metrics` de **B**, e os eventos da wallet publicados uma vez cada.

**Morte antes do commit** (sem proxy): o teste trava a wallet por SQL, A grava o inbox (não confirmado) e fica esperando o lock. `kill -9` em A; o inbox de M continua vazio para quem está fora da transação. O teste solta o lock, e B aplica M uma vez.
- **Detalhe do Postgres:** um backend esperando lock **não percebe** que o cliente morreu até conseguir o lock (`client_connection_check_interval` vem desligado). Só então ele tenta responder ao socket fechado e aborta a transação.
- Em produção, isso é limitado por `DB_LOCK_TIMEOUT_MS`. Até lá, o INSERT do inbox desse backend segura uma reentrega da mesma mensagem, que espera e depois segue normalmente.

**Publisher morto depois do aceite do SQS:** o proxy retém a resposta do `SendMessage`, e o teste confirma que o corpo enviado era o primeiro evento da wallet. Depois do `kill -9`, o COMMIT do publisher nunca acontece, e os eventos continuam pendentes. Outro processo os publica, a FIFO absorve o reenvio, e cada `eventId` chega uma vez.

**SIGTERM real:**
- O Nest fecha a app e reemite o sinal (`process.kill(process.pid, signal)`), então o processo termina **por SIGTERM** depois do shutdown limpo.
- Com M1 esperando o lock da wallet (segurado pelo teste, `DB_LOCK_TIMEOUT_MS` de 10 s no processo) e M2 do mesmo grupo no lote: M1 é concluída e recebe ack, M2 volta visível na hora (< 1,5 s), o log tem "SQS consumer stopped" e não tem o aviso de grace estourado. Outro processo aplica M2.

### D50. Prova de consistência depois do reinício

**Roteiro** (`restart-consistency.test.ts`), com 12 wallets de 1000.00 e uma carga determinística:
- por HTTP: 4 BETs de 5.00, 2 WINs de 3.00 e um REFUND de 7.00 cuja BET ainda não existe;
- por SQS: 4 BETs de 2.00 e uma reentrega.

Os passos:
1. **Carga com falhas:** 3 processos com todos os laços recebem a carga. No meio dela, `kill -9` no 1 e SIGTERM no 2. O `FleetClient` reenvia o que falhou para o processo vivo.
2. **Queda total:** `kill -9` no 3. O teste confirma que os 12 REFUNDs estão em PENDING_REFERENCE. As 12 BETs que eles esperam são enviadas por SQS **sem nenhum processo rodando**.
3. **Reinício:** 3 processos novos sobem, e o resto da carga (2 BETs de 5.00 por wallet) é enviado.
4. **Quiescência:** fila vazia (visíveis e em voo), REFUNDs liquidados e outbox sem pendentes.

**Provas:**
1. Todas as wallets reconciliadas pelo endpoint (`consistent: true`, saldo 968.00, 15 lançamentos), além do `assertAllWalletsMatchLedger` (saldo = Σ ledger = último `balance_after`, `version` = 1 + lançamentos).
2. Cada `Idempotency-Key` enviada (HTTP e SQS) existe uma vez e PROCESSED.
3. Cada `messageId` enviado tem exatamente uma linha no inbox, e a DLQ está vazia.
4. O conjunto de `eventId` lido da fila de eventos é igual ao conjunto de ids do outbox das wallets, com zero duplicatas.

**Medido** (linha do tempo impressa pelo teste):
- 3 processos e 12 wallets prontos em 0,7 s;
- `kill -9` aos 0,9 s e SIGTERM concluído aos 1,2 s;
- carga respondida com 4 reenvios para outro processo;
- queda total aos 1,9 s e 3 processos novos aos 2,6 s;
- quiescência aos 4,3 s;
- 372 eventos recebidos, 0 duplicatas, teste completo em ~7 s.

### D51. Imagem, migrations e compose

**Dockerfile** (multi-stage, `oven/bun:1.4.2-alpine`):
- **`dependencies`:** `bun install --frozen-lockfile --production`.
- **Runtime:** copia `node_modules`, `src`, `package.json` e **`tsconfig.json`**. O Bun lê o `tsconfig.json` para emitir a metadata dos decorators que o DI do Nest usa (seção 3), então ele precisa estar na imagem.
- Roda com `NODE_ENV=production`, como o usuário não-root `bun`, com `CMD ["bun", "src/main.ts"]`.
- Sem etapa de build (o Bun executa TypeScript); o typecheck fica no desenvolvimento.
- A imagem tem 205 MB. O `.dockerignore` deixa de fora `.env*`, `test`, `docs`, `scripts` e `.git`.

**Migrations:** `src/migrate.ts` roda `orm.migrator.up()` com as mesmas opções da app.
- Usa `@mikro-orm/migrations`, que já é dependência de produção, então a CLI (devDependency) fica fora da imagem.
- Roda no serviço one-shot `migrate`; as réplicas dependem dele com `service_completed_successfully` e não migram ao subir, o que evita corrida entre réplicas.

**Compose** (profile `app`, para que o `docker compose up -d --wait` do desenvolvimento continue subindo só Postgres e SQS):
- **`app`:** `deploy.replicas: ${APP_REPLICAS:-3}` e `ports: "${APP_PORTS:-3001-3003}:3000"`, uma porta do host por réplica.
- **Rede:** `env_file: .env`, com `DB_HOST=postgres`, `DB_PORT=5432` e `SQS_ENDPOINT=http://sqs:4566` sobrescritos para a rede interna.
- **Sinais:** `init: true` (tini: repassa o SIGTERM e recolhe zumbis) e `stop_grace_period: 25s`, acima dos graces de 10 s do consumer e dos workers.
- **Healthcheck:** `wget` no `/health/ready`.
- **Faixa de portas, sem balanceador:** dá para mirar uma réplica específica, por exemplo para mandar a mesma aposta a duas réplicas.

**Medido:**
- do zero (`down -v`), `docker compose --profile app up -d --build --wait` retornou em 26 s, com as 7 migrations aplicadas e 3 réplicas healthy;
- `docker compose --profile app stop app` levou de 0,7 a 1,3 s, com cada réplica registrando consumer, publisher e worker parados e saindo com 143 (SIGTERM).

### D52. Papéis das réplicas

| Opção | Resultado |
|---|---|
| **Toda réplica roda HTTP, consumer, publisher e worker (escolhida)** | Simétrico e simples; é o cenário "3+ instâncias" do enunciado, com 3 consumers, 3 publishers e 3 workers disputando; o pool de 10 por réplica comporta (5 + 1 + 1 em segundo plano, 3 para o HTTP; D40), e são 30 conexões no total |
| Serviços por papel com as flags existentes (`api` com as flags em `false`; `worker` com os laços) | Escala independente, mas são mais serviços sem pedido do enunciado, e o `worker` continua com HTTP para health e métricas |
| Nova variável `APP_ROLE` | Redundante com as três flags |

A separação por papel é a evolução natural e não exige código: são dois serviços no compose com flags diferentes.

### D53. Verificação pelo avaliador

`bun run verify:replicas` (`scripts/verify-replicas.ts`, portas em `REPLICA_PORTS`, padrão `3001,3002,3003`):
- confere o `/health/ready` de cada réplica;
- manda a mesma aposta 30× espalhada;
- roda a seção 8 com as apostas em réplicas diferentes;
- publica 30 mensagens (mais uma reentrega) na fila e espera os saldos;
- espera o outbox zerar (gauge de cada réplica);
- reconcilia todas as wallets tocadas, alternando réplicas;
- imprime o trabalho de cada réplica a partir do `/metrics` dela e sai com código ≠ 0 em qualquer falha.

A distribuição entre réplicas é **informativa**, não um critério de falha: a FIFO entrega grupos a quem estiver fazendo polling. Se as réplicas processaram menos mensagens do que foram enviadas, o script avisa que houve consumo fora delas. Isso aconteceu na validação, com um `bun run dev` no host ligado à mesma fila (11 de 30).

**Validado do zero:** `docker compose --profile app down -v`, os passos da seção "Rodando várias instâncias" do README como escritos, e `verify:replicas` com todas as verificações ok.

## 13. Autenticação

**Decisão: não implementada.** O enunciado deixa a autenticação a cargo do candidato, sem pontos na avaliação, e aceita não implementá-la desde que a decisão, o desenho e o ponto de extensão fiquem documentados (enunciado, seção 2). O tempo foi para correção financeira, concorrência e idempotência.

**Desenho que seria adotado:**
- **IdP externo, sem autenticação artesanal:** Keycloak (OIDC) como serviço no compose. Cada provedor de jogos é um client confidencial que obtém token por *client credentials*; o operador da plataforma (back-office) é outro client.
- **Validação na API:** o JWT é validado localmente, sem ida ao IdP a cada requisição: assinatura pela JWKS em cache, `iss`, `aud` e `exp`.
- **Escopos:**

  | Quem | Escopos | Rotas |
  |---|---|---|
  | Provedor | `wagering:submit`, `wagering:read` | `POST /wagering/transactions` e os dois GETs de transação |
  | Operador | `wallets:write`, `wallets:read`, `wallets:reconcile` | Rotas de wallet, ledger e reconciliação |

- **Identidade do provedor em cada rota:**
  - `POST /wagering/transactions`: o `providerId` do corpo precisa ser igual ao claim `provider_id`, senão 403. Isso impede um provedor de submeter transações em nome de outro;
  - `GET /providers/:providerId/wagering/transactions/:externalTransactionId`: a mesma regra, com o parâmetro de rota;
  - `GET /wagering/transactions/:transactionId`: uma transação de outro provedor responde 404, e não 403, para não revelar que ela existe.
- **Erros:** 401 (token ausente ou inválido) e 403 (escopo ou provedor errado), em problem+json como os demais (D23).
- **Fora da autenticação:** `/health/*` fica aberto, como pede o enunciado, e `/metrics` também, restrito por rede (D46). A fila SQS é tratada como canal interno confiável, mas o `providerId` da mensagem passa pelas mesmas validações de domínio: o provider `internal` é reservado (D10) e a idempotência é por provider (D19).

**Ponto de extensão no código:**
- `AuthGuard` no-op (`src/interfaces/http/auth/auth.guard.ts`), aplicado com `@UseGuards` no `WalletsController`, no `WageringController` e no `ProviderTransactionsController`.
- A implementação real troca só o corpo do `canActivate`: validar o token, conferir o escopo da rota e anexar a identidade (`ProviderIdentity`) ao request. Os controllers a recebem por um decorator (`@CurrentProvider()`) e passam o `providerId` autenticado aos casos de uso, que já recebem o provider explicitamente.
- `test/integration/http/wallets.test.ts` confere que o guard está registrado nos três controllers de negócio e ausente no `HealthController` e no `MetricsController`.

## 14. Limitações conhecidas

Cada item aponta a decisão que dá o contexto.

**Escopo não implementado**
- Autenticação: o desenho e o ponto de extensão estão na seção 13. Hoje, qualquer cliente que alcance a API chama todas as rotas.
- Teste de carga (diferencial opcional do enunciado), OpenTelemetry e dashboard. Os números de concorrência deste documento vêm dos testes funcionais, não de um experimento de carga; a vazão máxima de uma wallet quente não foi medida.
- O ledger registra um lançamento por movimento da wallet, não partidas dobradas (double-entry).

**Regras de negócio**
- O status FAILED e o código `PROCESSING_RETRIES_EXHAUSTED` não têm produtor: falhas de infraestrutura são retentadas, nunca gravadas como falha definitiva (D10).
- WIN e LOSS sem referência são aceitos: não há máquina de estados da rodada que exija uma BET antes (D10, D12).
- Só o formato ISO-4217 da moeda é validado, sem lista de moedas suportadas (D9).
- A política de PENDING_REFERENCE (8 tentativas, ≈ 3 min) é constante de domínio, não configuração (D12.1).
- A reconciliação só roda sob demanda: uma divergência só aparece quando alguém chama o endpoint (D42).
- `WALLET_PLAYER_MISMATCH` não é persistido; a trilha dele fica no log (D28).

**Mensageria**
- Mensagens com erro permanente vão para a DLQ com o motivo, mas o provedor não é avisado automaticamente (D30).
- Um long polling abortado no shutdown pode atrasar mensagens por até a visibilidade da fila (30 s), sem perdê-las (D33).
- O publisher mantém a transação aberta durante os envios ao SQS. O teto por ciclo é o timeout de cada envio vezes os eventos de uma wallet no lote (D36).
- Um evento que falha sempre (por exemplo, maior que o limite de 256 KB do SQS) segura os seguintes da mesma wallet indefinidamente, porque o outbox não tem limite de tentativas (D15, D36). O outbox lag (D44) é o alarme.
- Duplicatas depois da janela de 5 min da FIFO chegam ao consumidor de eventos, que precisa deduplicar por `eventId` (D37).
- A fila de eventos é ponto a ponto; mais de um consumidor pede SNS FIFO (D35).
- Os eventos publicados e as linhas do inbox ficam no banco para sempre: não há job de retenção. O guard do outbox já permite apagar os eventos publicados (D17).

**Concorrência e operação**
- As operações de uma wallet são serializadas pelo lock da linha: uma wallet muito disputada tem a vazão limitada pela duração de cada transação (D24, D26).
- Um backend do Postgres esperando lock não percebe que o cliente morreu até conseguir o lock (`client_connection_check_interval` vem desligado). A transação do processo morto só é desfeita depois disso, o que é limitado por `DB_LOCK_TIMEOUT_MS` (D49).
- Um Postgres só, sem réplica, failover nem backup configurados.
- A app conecta como dona das tabelas. A imutabilidade não depende disso (os triggers valem para todos), mas um role com privilégios mínimos seria a defesa em profundidade em produção (D20).
- Sem TLS entre a aplicação e as dependências (ambiente local).
- A LocalStack 4.14.0 está congelada e não recebe correções; se a tag sumir ou divergir, a saída é o MiniStack (D1).
- As réplicas do compose e um `bun run dev` no host usam o mesmo banco e as mesmas filas padrão; rodando juntos, dividem o consumo (D53).

**Observabilidade**
- Os gauges consultados no banco e no SQS saem repetidos em cada instância (agregar com `max`), e `ApproximateNumberOfMessages` é aproximado na AWS real (D44).
- A máscara de valores nas mensagens de erro é heurística: pega quantias com 2 casas, o formato de todo `Money` do sistema, mas não um número inteiro solto (D47).
- O problem de JSON malformado sai sem `correlationId`, porque o parser de corpo roda antes do middleware de log que atribui o id.
- Não há tracing distribuído; o rastreio é pelo `correlationId`, presente nos logs e nos eventos (D39, D47).

**Testes**
- Os testes de integração dependem do compose de pé; não são herméticos (D8).
- O teste de divergência da reconciliação exige superusuário no Postgres de testes (D42).
- Os testes multiprocesso rodam a aplicação como processos do host. A imagem é exercitada pelo `verify:replicas`, que não faz parte do `bun test` (D48, D53).
- Se o runner for morto com `kill -9` no meio de `test/multiprocess`, os processos filhos podem sobrar; o README traz o `pkill` pelo marcador (D48).
- O nestjs-pino 5 tem um logger por processo; duas apps no mesmo processo compartilham destino e nível, o que só acontece nos testes (D47).
- O teste HTTP concorrente da reconciliação não discrimina o nível de isolamento; a prova é o teste determinístico (D42).
