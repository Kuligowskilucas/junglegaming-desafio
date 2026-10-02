# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) de múltiplos provedores, com idempotência persistente, ledger imutável e transactional outbox. O enunciado completo está em [`docs/DESAFIO.md`](docs/DESAFIO.md). As decisões técnicas e os trade-offs estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Status:** Etapas 1 a 5 concluídas: infra local, aplicação NestJS em Bun, config validada, logs JSON, health checks; o modelo de domínio (Money, Wallet, ledger, WagerTransaction, regras de BET/WIN/LOSS/REFUND/ROLLBACK, inbox, outbox e eventos); o schema PostgreSQL com as garantias no banco (constraints, índices e triggers), a persistência, os endpoints de wallet, a submissão de transações com idempotência, lock por wallet e outbox, testada com concorrência real; o consumer SQS com inbox, ack após o commit, backoff, DLQ e shutdown limpo; e o publisher do outbox (várias instâncias, ordem por wallet, retry) e o worker que resolve as transações em PENDING_REFERENCE.

## Pré-requisitos

- Docker com Compose v2.20+ (precisa de `docker compose up --wait`)
- [Bun](https://bun.sh) **1.4.2**

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
exec $SHELL
bun --version   # 1.4.2
```

Não é preciso ter Node nem conta na LocalStack. A imagem `localstack/localstack:4.14.0` roda sem token (ver ARCHITECTURE.md, D1).

## Setup do zero

```bash
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d --wait      # retorna quando Postgres e SQS estão healthy e as filas existem
bun run db:migrate
bun run dev                      # http://localhost:3000
```

Conferindo:

```bash
curl -i localhost:3000/health/live     # 200 {"status":"ok"}
curl -i localhost:3000/health/ready    # 200 {"status":"ok","checks":{"postgres":{"status":"up"},"sqs":{"status":"up"}}}
docker compose exec sqs awslocal sqs list-queues
docker compose exec sqs sh -c 'awslocal sqs get-queue-attributes --attribute-names RedrivePolicy FifoQueue \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)"'
```

## Comandos

| Comando | O que faz |
|---|---|
| `docker compose up -d --wait` | Sobe Postgres 18 (porta `DB_PORT`, padrão 5433) e LocalStack 4.14.0 (porta 4566) com as filas criadas |
| `docker compose down -v` | Derruba tudo e apaga o volume do Postgres |
| `bun run dev` | Sobe a API com reload |
| `bun run start` | Sobe a API sem reload |
| `bun run typecheck` | `tsc --noEmit` (TypeScript 6.0.3, modo estrito) |
| `bun test` | Todos os testes (unitários e de integração) |
| `bun run test:unit` | Só os testes sem I/O (domínio, arquitetura, config) |
| `bun run test:integration` | Só os testes contra Postgres e SQS reais |
| `bun run test:concurrency` | Só os cenários com paralelismo real (seção 8, mesma aposta 50×, wallet quente, reversões simultâneas) |
| `bun run db:migrate` | Aplica as migrations pendentes (7: wallets, transações, ledger, coerência, inbox, outbox, ordem do outbox e correlação) |
| `bun run db:migrate:down` | Reverte a última migration |
| `bun run db:migration:create` | Cria uma migration em branco (SQL escrito à mão) |
| `bun run db:migration:list` | Lista as migrations executadas |

Para rodar as migrations no banco de testes: `NODE_ENV=test bun run db:migrate`. O Bun passa a carregar o `.env.test`, que aponta para `wagering_test`.

## API

Os erros saem em `application/problem+json` (RFC 9457) com `code`, `retryable` e `correlationId`. A tabela completa está em ARCHITECTURE.md, D23.

```bash
# criar wallet (201 + Location); com saldo inicial > 0 grava também o OPENING e o crédito no ledger
curl -si -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# repetir o mesmo player e moeda → 409 WALLET_ALREADY_EXISTS com o walletId existente

curl -s localhost:3000/wallets/<walletId>
curl -s 'localhost:3000/wallets/<walletId>/ledger?limit=50'                 # { items, nextCursor }
curl -s 'localhost:3000/wallets/<walletId>/ledger?limit=50&cursor=<nextCursor>'
```

```bash
# submeter uma transação: Idempotency-Key obrigatório; mesma key e mesmo payload → replay (idempotentReplay: true)
curl -si -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

Status da submissão (ARCHITECTURE.md, D27): 200 PROCESSED, 202 PENDING_REFERENCE (referência ainda não chegou; o worker a resolve quando ela chegar, D38), 422 rejeição de negócio (`code` = `failureCode`), 409 conflito de idempotência, 400 payload inválido, 503 com `Retry-After` para falha transitória (reenviar a mesma requisição é seguro).

O `amount` precisa ter exatamente 2 casas decimais (`"25.00"`). O ledger vem do lançamento mais recente para o mais antigo, e o cursor é opaco e estável mesmo com lançamentos novos chegando durante a paginação.

## Mensageria (SQS)

Com `SQS_CONSUMER_ENABLED=true` (padrão no `.env.example`), o processo da API também consome `wager-transactions.fifo`. A mensagem segue o envelope da seção 10 do enunciado, com `MessageGroupId` = `walletId` e `MessageDeduplicationId` = `messageId` (contrato em ARCHITECTURE.md, D32):

```bash
BODY='{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-123","idempotencyKey":"provider-a:transaction-123","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
docker compose exec sqs sh -c "awslocal sqs send-message \
  --queue-url \"\$(awslocal sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)\" \
  --message-group-id <walletId> --message-deduplication-id msg-123 --message-body '$BODY'"

curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123   # aplicada pelo consumer

# mensagens com erro permanente ficam na DLQ, com o motivo nos atributos
docker compose exec sqs sh -c 'awslocal sqs receive-message --message-attribute-names All \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)"'
```

Erros de negócio (por exemplo, saldo insuficiente) viram transação REJECTED e a mensagem recebe ack. Erros transitórios são retentados com backoff exponencial e só vão para a DLQ depois de `SQS_MAX_RECEIVE_COUNT` entregas (≈ 13,5 min). Erros permanentes (payload inválido, wallet inexistente, conflito de idempotência) vão direto para a DLQ com `errorCode`.

### Eventos publicados

Com `OUTBOX_PUBLISHER_ENABLED=true` (padrão no `.env.example`), os eventos do outbox (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) vão para `wager-events.fifo`, em ordem por wallet: `MessageGroupId` = `walletId`, `MessageDeduplicationId` = `eventId`, corpo = envelope do evento e atributos `eventType`, `eventId`, `aggregateId`, `correlationId` e `version` (ARCHITECTURE.md, D35). Quem consome deve deduplicar por `eventId`.

```bash
docker compose exec sqs sh -c 'awslocal sqs receive-message --max-number-of-messages 10 \
  --attribute-names MessageGroupId --message-attribute-names All \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-events.fifo --query QueueUrl --output text)"'
```

O `receive-message` não apaga: as mensagens lidas ficam invisíveis por 30 s e, numa FIFO, seguram o resto do grupo (da wallet) nesse intervalo.

Com `REFERENCE_WORKER_ENABLED=true` (padrão no `.env.example`), uma transação que voltou 202 PENDING_REFERENCE é resolvida em até ~1 s depois que a referência chega:

```bash
# REFUND antes da BET → 202; depois a BET → 200; o GET do REFUND passa a PROCESSED, e o saldo volta
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:refund-1' -H 'x-correlation-id: refund-request-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"refund-1","referenceExternalTransactionId":"bet-1","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp","kind":"REFUND","money":{"amount":"10.00","currency":"BRL"}}'
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}'
curl -s localhost:3000/providers/provider-a/wagering/transactions/refund-1
```

Os eventos que o worker emite carregam o `correlationId` da requisição original (`refund-request-1`).

## Testes

- **Unitários** (`test/unit`) não fazem I/O e não precisam da infra: domínio (`test/unit/domain`, incluindo regras de negócio, transições de status, hash de payload e um teste de propriedade do ledger com seed fixa), regra de dependência entre camadas (`test/unit/architecture`) e config.
- **Integração** (`test/integration`) usam PostgreSQL e LocalStack reais, sem mocks: migrations (up → down passo a passo → up), cada constraint e trigger violado por SQL, a coerência saldo ↔ ledger ↔ transação no COMMIT, repositórios e os endpoints de wallet (atomicidade, 10 POSTs simultâneos, cursor estável). A infra precisa estar de pé (`docker compose up -d --wait`). Se não estiver, o teste falha na hora com essa instrução.
- O `bun test` define `NODE_ENV=test` e carrega o `.env.test` por cima do `.env`. Os testes usam o banco **`wagering_test`**, criado pelo init do Postgres, e não tocam no banco de desenvolvimento.
- **Sem paralelismo entre arquivos que limpam o banco.** O `bun test` roda os arquivos em série por padrão, e os scripts nunca passam `--parallel`. Além disso, todo arquivo de integração chama `useIntegrationEnvironment()` (`test/support/integration.ts`). Ela toma um advisory lock no Postgres (`pg_advisory_lock`) numa conexão dedicada durante o arquivo inteiro. Mesmo com `bun test --parallel`, os arquivos de integração esperam uns pelos outros em vez de mexer nos dados de outro teste.
- Cada arquivo fecha a sua app Nest e as suas conexões no `afterAll`, porque os arquivos dividem o mesmo processo.
- **Consumer SQS** (`test/integration/sqs`): cada teste cria um par de filas FIFO próprio, com visibilidade curta, e cobre redelivery, crash entre commit e ack, retry transitório, DLQ, ordem por grupo e shutdown.
- **Publisher e worker** (`test/integration/workers`): cada teste do publisher usa uma fila de eventos própria e cobre dois publishers simultâneos (ordem por wallet, sem envio duplicado), instância morta antes de publicar, envio sem marcação absorvido pela deduplicação da FIFO, retry com backoff e evento em backoff segurando os seguintes da wallet. Os do worker cobrem REFUND antes da BET, ROLLBACK antes do WIN, o empurrão, novas tentativas, limite esgotado, replay, concorrência com o HTTP e dois workers.
- **Concorrência** (`test/concurrency`): requisições HTTP em paralelo contra o Postgres real. O cliente reenvia ao receber 503, respeitando o `Retry-After`, e cada cenário registra quantos 503 recebeu (resumo no fim da execução). Depois de cada teste, todas as wallets são conferidas contra o ledger. O `.env.test` usa `DB_POOL_MAX=20` para haver paralelismo real no banco.
- **Limpeza sem desligar triggers:** os arquivos que usam tabelas chamam `resetDatabase()`, que derruba e recria o schema (`DROP SCHEMA` + migrations) dentro do lock. O ledger é imutável e nem os testes apagam linhas dele. O reset recusa bancos cujo nome não termine em `_test`.

## Configuração

Toda a configuração vem de variáveis de ambiente, validadas na subida. Com algum valor inválido, a aplicação não sobe e lista os campos com problema. O Bun carrega o `.env` automaticamente, e o Compose lê o mesmo arquivo.

| Variável | Padrão | Descrição |
|---|---|---|
| `HTTP_PORT` | 3000 | Porta HTTP |
| `LOG_LEVEL` | info | `fatal`, `error`, `warn`, `info`, `debug`, `trace` ou `silent` |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | — | Conexão com o Postgres (também configuram o container) |
| `DB_POOL_MAX` | 10 | Tamanho máximo do pool por instância |
| `AWS_REGION` | — | Região do SQS |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | — | Lidas pelo SDK da AWS; no emulador, qualquer valor serve (`test`) |
| `SQS_ENDPOINT` | — | Endpoint do emulador; sem ele, o SDK usa a AWS real |
| `SQS_WAGER_QUEUE_NAME`, `SQS_WAGER_DLQ_NAME` | — | Nomes das filas FIFO (precisam terminar em `.fifo`) |
| `SQS_EVENTS_QUEUE_NAME` | wager-events.fifo | Fila FIFO dos eventos publicados |
| `SQS_MAX_RECEIVE_COUNT` | 10 | Entregas antes de a mensagem ir para a DLQ (usado na criação da fila) |
| `SQS_CONSUMER_ENABLED` | false | Liga o consumer no processo da API (`true` no `.env.example`) |
| `SQS_CONSUMER_NAME` | wager-transactions-consumer | Nome do consumer no inbox |
| `SQS_CONSUMER_CONCURRENCY` | metade de `DB_POOL_MAX` | Mensagens processadas ao mesmo tempo; consumer + publisher (1) + worker (1), os que estiverem ligados, precisam somar menos que `DB_POOL_MAX` |
| `SQS_WAIT_TIME_SECONDS` | 20 | Long polling por receive |
| `SQS_MAX_MESSAGES` | 10 | Mensagens por receive |
| `SQS_RETRY_BASE_SECONDS`, `SQS_RETRY_MAX_SECONDS` | 2, 300 | Backoff exponencial dos erros transitórios |
| `SQS_SHUTDOWN_GRACE_MS` | 10000 | Tempo para concluir mensagens em andamento no SIGTERM |
| `OUTBOX_PUBLISHER_ENABLED` | false | Liga o publisher do outbox no processo da API (`true` no `.env.example`) |
| `OUTBOX_POLL_INTERVAL_MS` | 500 | Espera do publisher quando não há eventos |
| `OUTBOX_BATCH_WALLETS`, `OUTBOX_BATCH_EVENTS_PER_WALLET` | 20, 50 | Tamanho do lote por ciclo |
| `OUTBOX_PUBLISH_TIMEOUT_MS` | 5000 | Timeout de cada envio ao SQS |
| `REFERENCE_WORKER_ENABLED` | false | Liga o worker de PENDING_REFERENCE (`true` no `.env.example`) |
| `REFERENCE_WORKER_POLL_INTERVAL_MS` | 1000 | Espera do worker quando não há transações vencidas |
| `REFERENCE_WORKER_BATCH` | 50 | Transações avaliadas por ciclo |
| `WORKER_SHUTDOWN_GRACE_MS` | 10000 | Tempo para o publisher e o worker concluírem o ciclo no SIGTERM |
| `DB_LOCK_TIMEOUT_MS` | 2000 | Espera máxima pelo lock de uma wallet; além disso, 503 retryable |
| `HEALTH_CHECK_TIMEOUT_MS` | 1000 | Timeout de cada dependência no `/health/ready` |

## Solução de problemas

- **Fila criada com `maxReceiveCount` antigo ou sem `wager-events.fifo`:** o LocalStack não persiste estado; `docker compose up -d --force-recreate --wait sqs` recria as filas com o script e o `.env` atuais.
- **Porta 5432 ou 5433 ocupada:** troque `DB_PORT` no `.env`.
- **O banco `wagering_test` não existe:** o init do Postgres só roda com o volume vazio. Rode `docker compose down -v && docker compose up -d --wait`.
- **Logs legíveis no terminal:** `bun run dev | bunx pino-pretty`.
