# Arquitetura

Este documento registra as decisões técnicas, os trade-offs e as limitações conhecidas. Ele cresce a cada etapa. O enunciado está em [`docs/DESAFIO.md`](docs/DESAFIO.md).

## 1. Stack e versões

| Item | Versão | Observação |
|---|---|---|
| Bun | 1.4.2 | Runtime, gerenciador de pacotes e test runner; executa o TypeScript direto, sem etapa de build |
| NestJS | 12.1.2 (`platform-express`) | Pacotes publicados como ESM |
| MikroORM | 7.2.3 (`@mikro-orm/nestjs` 7.1.0) | ESM-only, sem decorators (ver D3) |
| PostgreSQL | 18.6 (alpine) | |
| SQS | LocalStack 4.14.0 | Ver D1 |
| TypeScript | 6.0.3 | Usado só para checar tipos (`tsc --noEmit`) |
| zod | 4.6.5 | Validação do env; nas Etapas 3 e 4, validação dos DTOs (Standard Schema) |
| pino / nestjs-pino | 10.3.1 / 5.2.1 | Logs JSON |

Todas as dependências estão fixadas em versão exata, e o `bun.lock` é versionado.

### Decorators e metadata no Bun

O DI do NestJS descobre as dependências de um construtor lendo a metadata `design:paramtypes`, que o compilador emite quando `emitDecoratorMetadata` está ligado. É assim que a compatibilidade fica garantida:

1. **O Bun lê o `tsconfig.json`** e, com `experimentalDecorators` e `emitDecoratorMetadata`, emite essa metadata ao transpilar. Não usamos `nest build` nem `@nestjs/cli`.
2. **`import "reflect-metadata"`** é a primeira linha de `src/main.ts`. Nos testes, entra pelo `preload` do `bunfig.toml`.
3. **O MikroORM não depende de decorators.** O mapeamento será feito com `defineEntity` (D3), então decorators e metadata ficam restritos ao Nest.
4. **`isolatedModules` + `verbatimModuleSyntax` + `emitDecoratorMetadata`:** o `tsc` acusa o erro TS1272 quando um tipo puro (interface) aparece numa assinatura decorada. É exatamente o caso em que a metadata sairia como `Object` e o DI quebraria em runtime. Uma classe injetada é sempre importada como valor (`import { X }`), nunca com `import type`.
5. **ESM em tudo** (`"type": "module"`). Import circular entre módulos é proibido: em ESM ele vira erro de TDZ, e não o `undefined` silencioso do CommonJS.
6. **Prova executável:** o teste de integração sobe o `AppModule` real dentro do `bun test`, com controller, DI por tipo e MikroORM. Se a metadata não for emitida, ele falha.

**Por que TypeScript 6 e não 7:** o TS 7 (compilador nativo em Go) checa tipos mais rápido, mas ainda não tem API programática, que é de onde parte do ecossistema (lint, plugins) depende. Ficamos no 6.0.3 por estabilidade. Como o TS 6 mudou o padrão de `types` para `[]`, o tsconfig declara `types: ["bun"]` explicitamente.

## 2. Estrutura e regra de dependência

```
src/
├── main.ts, app.factory.ts, app.module.ts   composition root
├── domain/            puro: sem @nestjs, @mikro-orm, @aws-sdk (seção 4)
│   ├── shared/        Money, DomainError
│   ├── wallet/        Wallet, WalletLedgerEntry, LedgerDirection
│   ├── wagering/      WagerTransaction, Kind, Status, FailureCode
│   ├── messaging/     InboxMessage, OutboxMessage
│   └── events/        IntegrationEvent e subclasses
├── application/       casos de uso + portas (abstract classes)                   (Etapas 3–6)
├── infrastructure/    adaptadores de saída e serviços técnicos
│   ├── config/        AppConfig (env validado)
│   ├── database/      MikroORM, health, records, mappers, repositórios, migrations
│   ├── messaging/     cliente SQS, health, publisher do outbox
│   └── observability/ logs, métricas
└── interfaces/        adaptadores de entrada
    ├── http/          controllers, validação, mapeamento erro → status
    ├── sqs/           consumer com inbox                                          (Etapa 5)
    └── workers/       publisher do outbox, reprocessamento de PENDING_REFERENCE  (Etapa 5)
test/
├── support/  unit/  integration/  concurrency/
```

- A pasta de cima é a camada, e dentro dela vem o agregado. Há um único bounded context, e o caso de uso central escreve wallet, ledger, transação, inbox e outbox na mesma transação SQL. Separar por feature criaria imports cruzados o tempo todo. Com a camada no topo, a regra de dependência aparece no caminho do arquivo.
- **Regra:** `domain` não importa nada fora de si. `application` importa só `domain`. `infrastructure` e `interfaces` importam as duas. O teste de arquitetura (D16) varre os imports de `src/domain` e `src/application` e falha se a regra for violada.
- Módulos Nest só existem em `infrastructure/`, `interfaces/` e `app.module.ts`.

## 3. Decisões

### D1. Emulador SQS: LocalStack 4.14.0 fixada

Desde 23/03/2026, o `localstack/localstack:latest` é uma imagem única que exige conta e `LOCALSTACK_AUTH_TOKEN`. A `4.14.0`, de 26/02/2026, é a última que roda sem token.

| Opção | Prós | Contras |
|---|---|---|
| LocalStack `latest` | Atualizada | Exige conta e token: quem avalia não consegue subir o projeto sem se cadastrar |
| **LocalStack `4.14.0` (escolhida)** | Sem token; emulação de SQS FIFO, deduplicação, visibilidade e redrive madura e amplamente usada | Congelada (repositório arquivado, sem patches); imagem de cerca de 1 GB |
| MiniStack 1.5.x (alternativa considerada) | MIT, sem conta, cerca de 110 MB, sobe em menos de 2 s; compatível com LocalStack (porta 4566, `ready.d`, `awslocal`) | Projeto jovem, com fidelidade menos comprovada justamente em FIFO, redrive e visibilidade, das quais os testes de DLQ e redelivery da Etapa 5 dependem |

O critério foi a fidelidade do comportamento de FIFO e redrive. Para manter a troca barata, o serviço no Compose se chama `sqs` (e não `localstack`), e scripts e healthcheck usam só `awslocal`, presente nas duas imagens. **Trocar de emulador é mudar a linha `image:`.**

`SQS_ENDPOINT_STRATEGY=path` gera URLs de fila no formato `.../queue/<região>/<conta>/<nome>`, sem subdomínio por região. A aplicação não depende do host dessas URLs: com `endpoint` configurado, o SDK v3 envia toda requisição ao endpoint configurado e ignora o host da `QueueUrl`.

### D2. Criação das filas: script `ready.d` no container do emulador

O script `docker/sqs/init/ready.d/01-create-queues.sh` roda quando o LocalStack fica pronto, de novo a cada start, porque o emulador não persiste estado. O healthcheck do serviço consulta a fila principal (`awslocal sqs get-queue-url`), então `docker compose up --wait` só retorna depois que as filas existem.

| Fila | Atributos |
|---|---|
| `wager-transactions-dlq.fifo` | `FifoQueue=true`, retenção de 14 dias |
| `wager-transactions.fifo` | `FifoQueue=true`, `ContentBasedDeduplication=false` (o produtor envia `MessageDeduplicationId=messageId`), `VisibilityTimeout=30`, `ReceiveMessageWaitTimeSeconds=20` (long polling), `RedrivePolicy={deadLetterTargetArn: DLQ, maxReceiveCount: SQS_MAX_RECEIVE_COUNT}` |

Alternativas descartadas:
- **Criar na subida da aplicação:** em produção exigiria permissão de `CreateQueue` para a app e geraria corrida entre instâncias. Provisionamento é responsabilidade da infra (IaC), não do runtime.
- **Container `aws-cli` one-shot:** mais uma imagem e um serviço, sem ganho.
- **Script manual:** um passo a mais no setup.

A deduplicação e a ordenação do FIFO são **otimização**. As garantias de idempotência e consistência ficam no banco (Etapas 3 a 5).

### D3. Mapeamento MikroORM: records de persistência + mappers (aplicado em D21)

| Opção | Resultado |
|---|---|
| Decorators nas classes de domínio | **Proibido:** o domínio não importa MikroORM |
| A. `EntitySchema` mapeando as classes de domínio direto | Descartada: o ORM hidrata via `Object.create` e **ignora o `rehydrate`**, que o enunciado exige na reidratação; exige mapear campos privados (`_balance`) por nome; Money com Decimal precisaria de Embeddable e custom Type; o `version` gerido pelo ORM conflita com o do domínio, que só sobe quando o saldo muda |
| **B. Records com `defineEntity` + mappers (escolhida)** | Domínio 100% puro; o mapper chama `Wallet.rehydrate(...)`; colunas monetárias `numeric(19,2)` chegam do driver `pg` como string e viram `Money.from`, sem passar por `number`; tipos inferidos sem reflect-metadata. Custo: um record e um mapper por agregado |
| C. Records com decorators (`@mikro-orm/decorators/legacy`) | Descartada: o mesmo boilerplate de B, mais um pacote e dependência de decorators legados e metadata |

**Estratégia transacional (Etapas 3 e 4):** as escritas usam `em.transactional()` e leem a wallet com `em.findOne(WalletRecord, id, { lockMode: LockMode.PESSIMISTIC_WRITE })` (`SELECT ... FOR UPDATE`), o que serializa por `walletId`, sem lock global. **SQL cru só com justificativa explícita**, registrada na tabela abaixo.

| Onde | Por que SQL cru |
|---|---|
| *(nenhum até aqui)* | |

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
- `/health/*` fica fora do log automático de request, para não poluir com os probes. Falhas de readiness são logadas em `warn`, com a causa.
- Na Etapa 5, o consumer SQS e os workers usam `PinoLogger.runInContext(fn, { bindings: { correlationId, messageId, ... } })`, e os campos `transactionId`, `walletId` e `providerId` entram via `assign` no caso de uso.

### D6. Health checks

- **`GET /health/live`:** sempre 200 enquanto o processo responde. Não consulta dependências, para que uma queda do banco não faça o orquestrador reiniciar todas as instâncias em cascata.
- **`GET /health/ready`:** checa Postgres (`select 1`) e SQS (`GetQueueAttributes` nas duas filas) em paralelo, cada um com timeout `HEALTH_CHECK_TIMEOUT_MS`. Devolve 200 `{status:"ok", checks}` ou 503 `{status:"unavailable", checks}`, e cada dependência fica `up` ou `down` com `reason` igual a `timeout` ou `unavailable`. O endpoint é aberto, então a resposta não expõe mensagens de erro, hosts nem stack. Esses detalhes vão para o log.
- Escritos à mão, sem `@nestjs/terminus`: são duas checagens, e o `MikroOrmHealthIndicator` do terminus tem histórico de incompatibilidade com `defineConfig`.
- **O MikroORM 7 conecta sob demanda.** O `MikroORM.init` não abre conexão, e o primeiro `execute` faz isso. Consequência: a app sobe mesmo com o banco fora, o `/ready` responde 503 e volta a 200 sozinho quando o banco volta. Por isso o check usa `execute("select 1")` e não `checkConnection()`, que só informa "não conectado" antes da primeira query.
- A URL de cada fila é resolvida uma vez por `GetQueueUrl` e guardada em cache (`QueueUrlResolver`). Isso independe do emulador e do formato de URL.

### D7. Migrations

- Ficam em `src/infrastructure/database/migrations`, em TypeScript, cada uma com `up()` **e** `down()`. Usam `snapshot: false` porque o schema (constraints, índices, triggers de imutabilidade) é escrito à mão em SQL, e não gerado por diff de entidades.
- Rodam por comando (`bun run db:migrate`), **nunca na subida da app**, para evitar que três instâncias concorram para migrar o mesmo banco.
- A CLI do MikroORM é invocada como `bun ./node_modules/@mikro-orm/cli/cli.js`. Executada pelo caminho do arquivo, o Bun carrega `.env` e `.env.<NODE_ENV>` automaticamente; via `bunx`, não carrega. Com isso, `NODE_ENV=test bun run db:migrate` migra o banco de testes.
- A Etapa 3 adiciona um teste de reversibilidade (up → down → up).

### D8. Infra dos testes de integração

| Opção | Prós | Contras |
|---|---|---|
| **Compose já rodando (escolhida)** | Rápido; mesma infra do desenvolvimento; os testes multi-processo da Etapa 6 só precisam de host e porta | Exige `docker compose up -d --wait` antes; o isolamento é responsabilidade dos testes |
| testcontainers | Hermético | +5 a 15 s por execução; a compatibilidade com Bun só se estabilizou recentemente; o módulo de LocalStack assume a imagem com token |

Isolamento:
1. **Banco separado** `wagering_test`, criado pelo init do Postgres e selecionado pelo `.env.test`.
2. **Serialização entre arquivos:** o `bun test` roda os arquivos em série por padrão. Como garantia que não depende de flag, `useIntegrationEnvironment()` toma `pg_advisory_lock(<chave fixa>)` numa conexão dedicada (`Bun.SQL.reserve()`, sem dependência nova) no `beforeAll` e libera no `afterAll`. Com `bun test --parallel`, que distribui os arquivos entre processos, os arquivos de integração esperam uns pelos outros. **Verificado:** dois arquivos em processos distintos executaram em sequência estrita, o segundo começando só depois de o primeiro liberar o lock. Os processos filhos dos testes multi-instância (Etapa 6) não pedem esse lock e não ficam bloqueados por ele.
3. **Preflight:** se Postgres ou SQS não respondem, o arquivo falha de imediato com a instrução de subir a infra.
4. A estratégia de limpeza de dados entre testes, incluindo a convivência com os triggers de imutabilidade do ledger, é definida na Etapa 3, sempre dentro do lock.

Alternativa registrada: um banco por arquivo via `CREATE DATABASE ... TEMPLATE`. Daria paralelismo real, mas a complexidade não compensa no tamanho desta suíte.

## 4. Domínio

O código fica em `src/domain`, em TypeScript puro: não importa NestJS, MikroORM nem AWS SDK, e também não importa as outras camadas. O teste `test/unit/architecture/dependency-rule.test.ts` garante isso (D16). A única dependência externa é o `node:crypto` (D13).

Convenções:
- Construtor `private` com factories (`create`, `open`, `opening`, `enqueue`, `receive`, `from`). O `rehydrate(state)` reconstrói o estado persistido sem revalidar transições.
- O domínio não gera ids nem lê o relógio (D14).
- Rejeições de negócio são valores (`FailureCode`). Exceções ficam para entrada inválida (`DomainError`) e para erro de programação (`InvariantViolationError`) (D15).

### D9. Money: `bigint` em centavos, escala fixa de 2 casas

| Opção | Resultado |
|---|---|
| **`bigint` em centavos (escolhida)** | A escala é garantida pela própria representação, porque não existe terceira casa; aritmética nativa e exata; zero dependência; sem config global. `JSON.stringify` lança erro com `bigint`, então o valor cru nunca é serializado por engano: a saída passa sempre por `toJSON()` |
| `decimal.js` | Bateria com o `Decimal` do esqueleto, mas a precisão é arbitrária (a escala vira validação, não tipo), a config é global e o parser aceita `1e3`, `Infinity` e `0x10`, o que exigiria a mesma regex estrita de qualquer forma |
| `big.js` / `dinero.js` | Os mesmos contras de `decimal.js`, ou uma API maior que a necessidade |

O enunciado permite adaptar assinaturas desde que as garantias sejam preservadas. O contrato externo é o do enunciado: `{ "amount": "25.00", "currency": "BRL" }`.

**Entrada (`Money.from`)** exige `amount` como string com **exatamente 2 casas decimais**, pela leitura literal da seção 6.1 ("recebido e serializado ... sempre com escala fixa de 2 casas"). A regex é `^(0|[1-9]\d{0,16})\.\d{2}$`, só ASCII. Cada rejeição traz um `InvalidMoneyError.reason` estável:

| Motivo | Exemplos |
|---|---|
| `INVALID_FORMAT` | `""`, `" 25.00"`, `"+25.00"`, `"NaN"`, `"Infinity"`, `"1e3"`, `"0x10"`, `"25,00"`, `".50"`, `"025.00"`, número em vez de string |
| `INVALID_SCALE` | `"25"`, `"25.5"`, `"10.005"`: escala diferente de 2, **rejeitada e nunca arredondada** |
| `NEGATIVE_AMOUNT` | `"-5.00"`, `"-0.00"` |
| `OUT_OF_RANGE` | Mais de 17 dígitos inteiros, o que não cabe em `numeric(19,2)` (Etapa 3). Rejeitar aqui vira 400, e não um erro de banco (500) |
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
- **Campos além do esqueleto:**
  - `observedBalance`: o saldo visto no desfecho (PROCESSED ou REJECTED). É o "saldo observado naquele momento" que o replay precisa devolver (seção 7), inclusive para LOSS e REJECTED, que não geram lançamento.
  - `updatedAt`.
  - `referenceAttempts` e `nextReferenceAttemptAt`, para o reprocessamento de PENDING_REFERENCE (D12).
- `reject` aceita só `RejectionCode` e `fail` só `FailedCode`, ambos subconjuntos de `FailureCode`. O compilador impede trocar um pelo outro.

### D11. Wallet, ledger e `version`

- `debit(movement)` e `credit(movement)` recebem `{ entryId, transactionId, money, at }` e **devolvem o `WalletLedgerEntry`** daquele movimento. Saldo e lançamento saem juntos porque:
  1. não existe outra forma de alterar o saldo (sem setter; `rehydrate` só reconstrói);
  2. o método monta o lançamento com os mesmos `balanceBefore` e `balanceAfter` que aplica, e só altera a wallet **depois** que o lançamento foi validado;
  3. `WalletLedgerEntry.create` confere `balanceBefore ± money = balanceAfter`, moeda única, valor positivo e saldos não negativos.

  O lançamento devolvido é o que a Etapa 4 persiste na mesma transação SQL e usa no `WalletBalanceChanged`.
- `debit` além do saldo lança `InsufficientBalanceError`, um erro de invariante: o caminho de negócio consulta `canDebit` antes e transforma o resultado em `FailureCode` (D12). O saldo nunca fica negativo, nem em memória.
- Cada lançamento carrega `walletVersion`, a versão da wallet que ele produziu (OPENING = 1). É a ordem total por wallet usada no schema e no cursor (D17, D22).
- **`version = 1 + número de lançamentos da wallet, sem contar o OPENING`.** `Wallet.open` cria com `version = 1` e já devolve o lançamento CREDIT de abertura quando o saldo inicial é positivo, como no exemplo da seção 9 (saldo 1000.00, version 1). Cada `debit` ou `credit` posterior soma 1. LOSS e rejeições não mexem na version.
- O `WalletLedgerEntry` é estruturalmente imutável: campos `readonly`, `Object.freeze` e nenhum método de transição. As datas do domínio são guardadas como epoch e entregues como cópias, porque `Date` é mutável em JS.
- Um teste de propriedade aplica 1000 movimentos aleatórios, com seed fixa, e confere: saldo igual ao reconstruído pelo ledger, todos os lançamentos balanceados, `balanceBefore` de cada um igual ao `balanceAfter` do anterior, saldo nunca negativo e `version = 1 + lançamentos sem o OPENING`.
- A unicidade de wallet por `playerId + currency` não pode ser garantida em memória. Fica com o índice único da Etapa 3.

### D12. Regras por kind, referências e taxonomia de `FailureCode`

`settleWagerTransaction` (`src/domain/wagering/wager-settlement.ts`) é o serviço de domínio que aplica a seção 7. É uma função pura: recebe a transação (PENDING ou PENDING_REFERENCE), a wallet já travada pelo chamador, a referência resolvida por `(providerId, referenceExternalTransactionId)` (ou `undefined`), o fato `referenceAlreadyReversed` e o id do lançamento. Ela muta os agregados pelos próprios métodos deles e devolve o desfecho: PROCESSED (com ou sem lançamento), REJECTED com código, ou PENDING_REFERENCE.

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

**Uma referência só pode ser revertida uma vez, qualquer que seja o tipo.** A regra literal do enunciado ("pelo mesmo tipo de operação") permitiria um REFUND **e** um ROLLBACK da mesma BET, o que creditaria a aposta duas vezes. ROLLBACK de um REFUND continua permitido, porque a referência é outra (o próprio REFUND). Na Etapa 4, `referenceAlreadyReversed` = "existe REFUND ou ROLLBACK PROCESSED apontando para esta referência". Na Etapa 3, um índice único parcial garante isso no banco.

**D12.1. Referência fora de ordem (seção 7.1):** cada avaliação sem a referência chama `markPendingReference(now)`, que soma uma tentativa e agenda a próxima com backoff exponencial de 1 s × 2, com teto de 60 s. Depois de **8 tentativas** (≈ 183 s de espera acumulada: 1+2+4+8+16+32+60+60), a próxima avaliação rejeita com `REFERENCE_NOT_FOUND`, ou com `REFERENCE_NOT_PROCESSED` se a referência existe mas nunca terminou. Justificativa: a inversão típica (rede, fila) se resolve em segundos; minutos sem a referência indicam que ela não virá e que o provedor precisa agir.

**Taxonomia de `FailureCode`:**

| Código | Status | Quando | O que o provedor deve fazer |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | BET maior que o saldo | Desistir; o jogador está sem saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | ROLLBACK de WIN ou REFUND deixaria o saldo negativo | Escalar para tratamento manual; é situação operacional, não de jogador |
| `CURRENCY_MISMATCH` | REJECTED | Moeda diferente da moeda da wallet | Corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | REJECTED | `playerId` não é o dono da `walletId` | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | REJECTED | Referência ausente depois do limite de tentativas | Enviar a referência e reenviar a operação com uma nova key |
| `REFERENCE_INVALID_KIND` | REJECTED | Tipo de referência não permitido para o kind | Corrigir o payload |
| `REFERENCE_MISMATCH` | REJECTED | Referência de outro player, wallet, rodada ou moeda | Corrigir o payload |
| `REFERENCE_AMOUNT_MISMATCH` | REJECTED | Valor do REFUND ou ROLLBACK diferente do valor da referência | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | REJECTED | A referência terminou REJECTED ou FAILED, ou nunca terminou | Desistir; não há o que reverter |
| `REFERENCE_ALREADY_REVERSED` | REJECTED | A referência já foi revertida | Desistir; a reversão já foi feita |
| `PROCESSING_RETRIES_EXHAUSTED` | FAILED | Reservado para a Etapa 5: erro de infra persistente depois do limite | Reenviar mais tarde ou acionar suporte |

Erros de validação de payload não criam transação e não são `FailureCode`: viram `InvalidMoneyError` ou `InvalidWagerTransactionError`, cada um com `reason` estável. O mapeamento para HTTP vem na Etapa 4. Se `WALLET_PLAYER_MISMATCH` será persistido como REJECTED ou só respondido como 4xx também é decidido na Etapa 4.

### D13. `payloadHash`

- **Fica no domínio** (`src/domain/wagering/wager-payload.ts`):
  - "mesma key com payload diferente é conflito" é regra de negócio, e escolher os campos que identificam a operação é conhecimento de domínio;
  - o `create` calcula o hash a partir dos próprios campos;
  - é síncrono, determinístico e sem I/O; o `node:crypto` é biblioteca padrão do runtime.
- **Campos:** `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e `referenceExternalTransactionId` (omitido quando ausente). O `Idempotency-Key`, o `messageId`, o `occurredAt`, o `type` e qualquer metadado de transporte ficam de fora. A função copia campo a campo, então propriedades extras nunca entram.
- **JSON canônico:** chaves ordenadas recursivamente por code unit UTF-16, sem espaços, strings escapadas por `JSON.stringify`, chaves `undefined` omitidas e só strings como valores. É compatível com a RFC 8785 (JCS) nesse subconjunto.
- **Digest:** SHA-256, em hex minúsculo (64 caracteres).
- **Vetor dourado** (exemplo da seção 9): o JSON canônico `{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-…","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-…"}` gera `629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344`. O teste fixa esse valor, calculado de forma independente com `sha256sum`. Qualquer mudança que invalidaria os hashes já gravados quebra o teste.

### D14. Ids e datas por parâmetro

Factories e transições recebem `id`, `entryId` e `at` explicitamente. Os testes usam valores fixos e são totalmente determinísticos. As portas `Clock` e `IdGenerator` ficam na aplicação (Etapa 3), implementadas na infra com `new Date()` e `Bun.randomUUIDv7()`. No domínio, elas só acrescentariam indireção.

### D15. Backoff do outbox e erros de domínio

- **`OutboxMessage.scheduleRetry(now)`:** `attempts + 1` e próxima tentativa em `min(1 s × 2^(attempts−1), 5 min)`, sem jitter. **Sem limite de tentativas:** um evento confirmado nunca é descartado. Depois do teto, continua tentando a cada 5 min, e o atraso aparece na métrica de outbox lag (Etapa 6). O jitter só ajudaria com muitos publishers sincronizados, e cada linha tem a própria agenda. O `OutboxMessage.enqueue(event)` usa `eventId` como id e guarda `event.toJSON()` congelado como payload.
- **`DomainError`** (com `code`; vira 4xx na Etapa 4): `InvalidMoneyError`, `CurrencyMismatchError`, `InvalidWagerTransactionError`.
- **`InvariantViolationError`** (bug do chamador; vira 500): `InvalidTransactionStateError`, `InvalidOutboxStateError`, `InvalidInboxStateError`, `InsufficientBalanceError`, `InvalidLedgerEntryError`, `InvalidOperationError`.
- Eventos de integração: cada subclasse fixa `eventType` e `version = 1` no tipo. O `data` carrega só `MoneyProps` e strings ISO-8601, é congelado em profundidade e o `from` recusa um agregado no estado errado. O `WalletBalanceChanged.from` exige que o lançamento seja o último movimento da wallet, para que `walletVersion` e `balanceAfter` sejam coerentes.

### D16. Teste de arquitetura

`test/unit/architecture/dependency-rule.test.ts` lê todo `.ts` de `src/domain` e `src/application` e extrai os imports por regex sobre o texto, o que pega também `import type`, `export … from`, `import()` e `require`. Ele falha quando:
- aparece `@nestjs/*`, `@mikro-orm/*` ou `@aws-sdk/*`;
- `domain` importa de outra camada;
- `application` importa de `infrastructure` ou `interfaces`.

Para não passar vazio, o teste exige que `src/domain` tenha arquivos, e um auto-teste prova que o scanner reconhece cada forma de import. Verificado manualmente: um arquivo de prova com `import "@nestjs/common"` e um `import type` da infraestrutura fez o teste falhar apontando as duas violações.

## 5. Persistência e API de wallets

Etapa 3: o domínio chega ao PostgreSQL por migrations escritas à mão, records `defineEntity`, mappers e repositórios atrás de portas da aplicação. Os três endpoints de wallet ficam atrás de um `AuthGuard` no-op.

### D17. Schema e tabela de garantias

São 6 migrations em `src/infrastructure/database/migrations`, uma por assunto, todas com `up` e `down`: `wallets`, `wager_transactions`, `wallet_ledger_entries`, os triggers de coerência, `inbox_messages` e `outbox_messages`. Cada regra tem um nome `<tabela>_<regra>`. **As regras impostas por trigger levantam `check_violation` com `CONSTRAINT = '<nome>'`.** Assim, `CHECK`, `UNIQUE`, FK e trigger chegam à aplicação e aos testes do mesmo jeito, pelo campo `constraint` do erro.

| Garantia | Onde |
|---|---|
| Uma wallet por `player_id + currency` | `wallets_player_currency_key` |
| Saldo nunca negativo | `wallets_balance_non_negative`; o ledger também tem `wallet_ledger_entries_balances_non_negative` |
| `version` sobe exatamente 1 quando o saldo muda e não muda quando o saldo não muda | trigger `wallets_version_follows_balance` |
| Identidade da wallet imutável | trigger `wallets_identity_immutable` |
| Idempotência persistente | `wager_transactions_idempotency_key` = `UNIQUE (provider_id, idempotency_key)` (D19) |
| Um id externo por provider; resolução de referência | `wager_transactions_external_id_key` |
| Uma reversão por referência, qualquer que seja o tipo (P7 da E2) | índice único parcial `wager_transactions_one_reversal_per_reference` em `reference_transaction_id` `WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| Regras de kind iguais às do domínio | `wager_transactions_amount_by_kind`, `_reference_by_kind`, `_no_self_reference`, `_opening_is_internal` |
| Coerência entre status e campos | `wager_transactions_*_by_status` (failure code, `processed_at`, `observed_balance`, agenda de PENDING_REFERENCE, referência resolvida) |
| Transação terminal imutável, payload imutável, sem volta para PENDING, sem DELETE/TRUNCATE | trigger `wager_transactions_guard` (`_terminal_immutable`, `_payload_immutable`, `_transition_valid`, `_append_only`) |
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
| Evento pendente não se perde; conteúdo imutável; publicado só uma vez | trigger `outbox_messages_guard` (`_retention`, `_content_immutable`, `_published_once`) |

**Coerência deferida.** Os três *constraint triggers* são `DEFERRABLE INITIALLY DEFERRED`: rodam no COMMIT, quando wallet, transação e lançamento já estão todos gravados. As FKs continuam imediatas, então a ordem de inserção é fixa (wallet → transação → lançamento → outbox). As mensagens nomeiam a regra e os valores, e o `DETAIL` traz `chave=valor` para log. Exemplo real:

```
wallet_ledger_entries_match_transaction: entry … for transaction … (ROLLBACK of WIN …) has direction CREDIT, expected DEBIT
DETAIL: wallet_id=… wallet_version=3 transaction_id=… kind=ROLLBACK reference_transaction_id=… reference_direction=CREDIT expected_direction=DEBIT received_direction=CREDIT
```

**Índices para os workers.** `wager_transactions_pending_reference_due` (parcial em PENDING_REFERENCE, por `next_reference_attempt_at`) e `outbox_messages_pending_due` (parcial em pendentes, por `coalesce(next_attempt_at, occurred_at), id`) servem às Etapas 5 e 6. O `wallet_ledger_entries_wallet_version_key` é também o índice da paginação.

### D18. Dinheiro no banco: `numeric(19,2)`

| Opção | Resultado |
|---|---|
| **`numeric(19,2)` (escolhida)** | Legível em auditoria; a aritmética do lançamento é um `CHECK` exato; `SUM()` da reconciliação sai em reais; o `pg` devolve `"975.00"`, que entra direto em `Money.from` com a mesma regra de 2 casas; os 17 dígitos inteiros são exatamente o teto `OUT_OF_RANGE` do domínio |
| `bigint` de centavos | Igual ao interno do domínio, mas ilegível em SQL ad hoc, obrigaria o domínio a expor centavos e **não comporta o teto do domínio** (`int8` vai até 92.233.720.368.547.758,07) |

A moeda fica em `char(3)` com `CHECK (currency ~ '^[A-Z]{3}$')`. Observação para quem usa o `Bun.SQL` em testes: no protocolo binário ele devolve o `numeric` zero como `"0"`; os testes fazem `::text` nas asserções. A aplicação usa o `pg`, que sempre devolve as 2 casas.

### D19. Escopo da idempotency key: por provider

`UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. Com unicidade global, o provider A poderia usar a key `provider-b:tx-1` e bloquear o B, ou receber o replay da resposta do B, com o saldo de um jogador alheio. Com a key separada por provider, a busca de replay é sempre `(provider_id, idempotency_key)` e usa o próprio índice. O OPENING usa o provider reservado `internal`.

### D20. Imutabilidade e limpeza do banco de testes

Os triggers `BEFORE UPDATE OR DELETE` (por linha) e `BEFORE TRUNCATE` (por comando) disparam para qualquer usuário, inclusive o dono e superusuários; a única exceção é `session_replication_role = replica`, que a aplicação nunca usa. `TRUNCATE wallets CASCADE` também falha, porque os triggers de TRUNCATE disparam nas tabelas alcançadas pelo cascade. Defesa em profundidade sugerida para produção (fora do escopo): rodar a app com um role sem `UPDATE`, `DELETE` e `TRUNCATE` no ledger.

**Os testes nunca limpam com DML.** `resetDatabase()` (`test/support/database.ts`) roda `DROP SCHEMA public CASCADE; CREATE SCHEMA public` e depois o `migrator.up()`, uma vez por arquivo, dentro do advisory lock (D8). DDL não passa pelos triggers de DML, então **os triggers ficam ativos em todos os testes**, sem bypass. Dentro de um arquivo, os testes se isolam com ids novos. O reset recusa qualquer banco cujo nome não termine em `_test`. Alternativa descartada: `session_replication_role = replica` + `TRUNCATE`, que exige superusuário e desliga também as FKs.

### D21. Persistência: records, mappers, repositórios e transação

- **Records** `defineEntity` em `src/infrastructure/database/records`, só dados e sem relações declaradas. **Mappers** convertem record ↔ domínio via `rehydrate` e `Money.from`/`toJSON`.
- **Portas** em `src/application/ports` (abstract classes que servem de token de DI): `WalletRepository`, `WagerTransactionRepository`, `WalletLedgerRepository`, `OutboxRepository`, `TransactionRunner`, `Clock`, `IdGenerator`. **Adaptadores** em `src/infrastructure/database/repositories` e `src/infrastructure/system` (`new Date()`, `Bun.randomUUIDv7()`). Os casos de uso não importam Nest; são ligados por `useFactory` no `WalletsModule`.
- **Inserções com `em.insert`**, que executa na hora e na ordem chamada. Records sem relações não informam ao Unit of Work a ordem das FKs, então o `persist` + `flush` poderia inserir fora de ordem.
- **Atualização da wallet:** `findByIdForUpdate` = `em.findOne(…, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true })` (`SELECT … FOR UPDATE`, exige transação aberta) e `update` = `em.assign` + `flush` sobre o record carregado. É o caminho de D3 que a Etapa 4 usa.
- **Transação:** `MikroOrmTransactionRunner.run(work)` = `em.transactional(() => work())`. O MikroORM guarda o fork transacional num `AsyncLocalStorage`, e os repositórios, que recebem o `EntityManager` global, entram nele automaticamente. **Cuidado:** um `em.fork()` comum tem `useContext: false` e ignora esse contexto, gravando fora da transação. Os testes que montam repositórios à mão usam `fork({ useContext: true })`. Isso foi descoberto quando o trigger `wallets_balance_matches_ledger` barrou um commit em que a wallet tinha sido gravada fora da transação.
- **Tradução de erros:** `UniqueConstraintViolationException` com `constraint = 'wallets_player_currency_key'` vira `WalletAlreadyExistsError`. Qualquer outra violação sobe como está (bug → 500).
- **SQL cru:** nenhum na aplicação até aqui (registro de D3).

`POST /wallets` faz, numa transação SQL: `Wallet.open` → wallet; se o saldo inicial for positivo, `WagerTransaction.opening` → transação → lançamento CREDIT de abertura → outbox com `WagerTransactionProcessed` e `WalletBalanceChanged` (P6), que levam o `correlationId` da requisição. Se a wallet já existir, a aplicação busca o id da existente depois do rollback e o devolve no 409.

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
| Banco inalcançável, deadlock, lock timeout, falha de serialização | 503 + `Retry-After: 1` | `DEPENDENCY_UNAVAILABLE` | true |
| Erro inesperado ou de invariante | 500 | `INTERNAL_ERROR` | false |

Reservado para a Etapa 4, na mesma convenção: 400 `INVALID_WAGER_TRANSACTION` (+ `reason`) e `MISSING_IDEMPOTENCY_KEY`; 409 `IDEMPOTENCY_CONFLICT`; 422 para rejeição de negócio (com o resultado da transação e o `failureCode`); 202 para PENDING_REFERENCE.

O `/health/ready` define o 503 por `@Res({ passthrough: true })` e não passa pelo filtro, mantendo o formato próprio de D6.

## 6. Autenticação

Fora do escopo implementado; a seção 2 do enunciado aceita essa decisão. O desenho que adotaríamos:
- **IdP externo (Keycloak, OIDC).** Cada provedor de jogos é um client confidencial e obtém token via *client credentials*.
- A API valida o JWT localmente (assinatura via JWKS em cache, `iss`, `aud`, `exp`). Um claim `provider_id` precisa ser igual ao `providerId` do corpo, senão a resposta é 403. Isso impede um provedor de submeter transações em nome de outro.
- **Ponto de extensão no código:** `AuthGuard` no-op (`src/interfaces/http/auth/auth.guard.ts`), aplicado com `@UseGuards` no `WalletsController` e, na Etapa 4, nos controllers de wagering. Um teste confere que ele está registrado. Os endpoints de health ficam abertos. A fila SQS é tratada como canal interno confiável, mas o `providerId` da mensagem passa pelas mesmas validações de domínio.

## 7. Limitações conhecidas

- A LocalStack 4.14.0 está congelada e não recebe correções. Se a tag deixar de existir ou aparecer uma divergência de comportamento, a saída é o MiniStack (D1).
- A aplicação ainda roda no host. O Dockerfile e o serviço `app` com réplicas entram na Etapa 5 ou 6.
- Sem TLS entre a aplicação e as dependências locais (ambiente de desenvolvimento).
- A app conecta como dono das tabelas. A imutabilidade não depende disso (triggers valem para todos), mas um role com privilégios mínimos seria a defesa em profundidade em produção (D20).
- O `correlationId` não aparece no problem de JSON malformado, porque o parser de corpo roda antes do middleware de log que atribui o id.
