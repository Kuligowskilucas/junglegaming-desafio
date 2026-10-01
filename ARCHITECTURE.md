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
├── domain/            puro: sem @nestjs, @mikro-orm, @aws-sdk                    (Etapa 2)
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
- **Regra:** `domain` não importa nada fora de si. `application` importa só `domain`. `infrastructure` e `interfaces` importam as duas. Na Etapa 2 entra um teste que varre os imports de `src/domain` e `src/application` e falha se aparecer `@nestjs`, `@mikro-orm` ou `@aws-sdk`.
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

### D3. Mapeamento MikroORM: records de persistência + mappers

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

## 4. Autenticação

Fora do escopo implementado; a seção 2 do enunciado aceita essa decisão. O desenho que adotaríamos:
- **IdP externo (Keycloak, OIDC).** Cada provedor de jogos é um client confidencial e obtém token via *client credentials*.
- A API valida o JWT localmente (assinatura via JWKS em cache, `iss`, `aud`, `exp`). Um claim `provider_id` precisa ser igual ao `providerId` do corpo, senão a resposta é 403. Isso impede um provedor de submeter transações em nome de outro.
- **Ponto de extensão no código:** um `AuthGuard` no-op aplicado aos controllers de negócio, que entra na Etapa 4. Os endpoints de health ficam abertos. A fila SQS é tratada como canal interno confiável, mas o `providerId` da mensagem passa pelas mesmas validações de domínio.

## 5. Limitações conhecidas

- A LocalStack 4.14.0 está congelada e não recebe correções. Se a tag deixar de existir ou aparecer uma divergência de comportamento, a saída é o MiniStack (D1).
- A aplicação ainda roda no host. O Dockerfile e o serviço `app` com réplicas entram na Etapa 5 ou 6.
- Sem TLS entre a aplicação e as dependências locais (ambiente de desenvolvimento).
