# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND e ROLLBACK) recebidas de vários provedores de jogos, por HTTP e por SQS, e mantém a carteira (wallet) de cada jogador. Ele continua correto quando as mensagens chegam duplicadas, fora de ordem ou ao mesmo tempo em várias instâncias.

**Garantias** (cada uma com a decisão e a prova no [ARCHITECTURE.md](ARCHITECTURE.md)):
- **Dinheiro exato:** valores com exatamente 2 casas decimais, sem `number` em nenhum ponto (D9, D18).
- **Idempotência persistente:** a mesma operação reenviada devolve o resultado original; a mesma chave com outro payload é conflito (D13, D19, D25).
- **Sem lost update nem saldo negativo:** cada wallet é travada na própria linha do banco, sem lock global (D24).
- **Ledger imutável e coerente com o saldo**, garantido por constraints e triggers no banco, não só no código (D11, D17).
- **Nenhum evento antes do commit:** os eventos entram num transactional outbox na mesma transação SQL e são publicados depois, em ordem por wallet (D35–D37).
- **Correto com várias instâncias:** provado com 3 processos reais, `kill -9`, SIGTERM e reinício (D48–D50).

O [mapa de avaliação](ARCHITECTURE.md#1-mapa-de-avaliação) aponta, para cada critério, as decisões, o código e os testes.

## Sumário

- [Visão rápida](#visão-rápida)
- [Pré-requisitos](#pré-requisitos)
- [Setup do zero](#setup-do-zero)
- [Rodando várias instâncias (Docker)](#rodando-várias-instâncias-docker)
- [Comandos](#comandos)
- [API](#api)
- [Mensageria (SQS)](#mensageria-sqs)
- [Observabilidade](#observabilidade)
- [Testes](#testes)
- [Configuração](#configuração)
- [Solução de problemas](#solução-de-problemas)
- [Documentação](#documentação)

## Visão rápida

```
     provedores (HTTP)                                  wager-transactions.fifo (SQS)
            │                                                        │
            ▼                                                        ▼
   POST /wagering/transactions                     consumer (inbox na mesma transação)
            └──────────────────────► núcleo transacional ◄───────────┘
                     lock da wallet → regras de negócio → transação + ledger + saldo + outbox
                                        │  uma transação SQL no PostgreSQL
                                        ▼
            worker de PENDING_REFERENCE      publisher do outbox ──► wager-events.fifo (SQS)
```

Cada instância roda a API HTTP, o consumer, o publisher e o worker; todas compartilham o mesmo Postgres e as mesmas filas. A arquitetura completa está na [visão geral do ARCHITECTURE.md](ARCHITECTURE.md#2-visão-geral).

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

Uma instância no host, para desenvolver:

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

## Rodando várias instâncias (Docker)

A imagem da aplicação e as réplicas ficam no profile `app` do compose, então o `docker compose up -d --wait` do setup acima continua subindo só Postgres e SQS. Com o profile, sobem também:
- um serviço `migrate`, que aplica as migrations uma vez e termina;
- **3 réplicas**, cada uma com HTTP, consumer, publisher e worker, expostas nas portas **3001, 3002 e 3003**.

Do zero, num clone novo:

```bash
cp .env.example .env
bun install --frozen-lockfile                        # o script de verificação usa o SDK do SQS
docker compose --profile app up -d --build --wait    # retorna com postgres, sqs e as 3 réplicas healthy
docker compose --profile app ps                      # 3 linhas "app" healthy, nas portas 3001–3003
bun run verify:replicas
```

O `verify:replicas` (`scripts/verify-replicas.ts`):
1. confere o `/health/ready` de cada réplica;
2. manda a mesma aposta 30 vezes, espalhada entre as réplicas (um débito só);
3. manda duas apostas de 80.00 sobre um saldo de 100.00 a réplicas diferentes (uma processada, outra rejeitada);
4. publica 30 mensagens na fila (mais uma reentrega) e espera o processamento;
5. confere que o outbox foi todo publicado;
6. reconcilia todas as wallets tocadas, alternando as réplicas.

No fim, imprime o trabalho de cada réplica (lido do `/metrics` de cada uma) e sai com código ≠ 0 se qualquer verificação falhar. Exemplo de saída:

```
ok    replica 1 (:3001) is ready
…
ok    16 wallets reconciled across the replicas, all consistent

Work per replica (from each replica's /metrics):
  replica 1 (:3001): 11 HTTP transactions, 9 SQS transactions in this run, 4 events published, 9 duplicates detected
  …
All checks passed.
```

Manualmente:

```bash
for port in 3001 3002 3003; do curl -s localhost:$port/health/ready; echo; done
docker compose --profile app logs app | grep '"Wager transaction message handled"'   # o prefixo mostra qual réplica processou
docker compose --profile app stop app      # SIGTERM: cada réplica conclui o trabalho em andamento e sai
docker compose --profile app down          # remove as réplicas e mantém o volume do Postgres
```

Para outra quantidade de réplicas, ajuste o número e a faixa de portas juntos: `APP_REPLICAS=5 APP_PORTS=3001-3005 docker compose --profile app up -d --wait` (e `REPLICA_PORTS=3001,3002,3003,3004,3005 bun run verify:replicas`).

As réplicas usam o banco `wagering` e as filas padrão, as mesmas de um `bun run dev`. Com os dois rodando, ambos consomem a mesma fila, e o resumo do verify avisa quantas mensagens foram processadas fora das réplicas.

## Comandos

| Comando | O que faz |
|---|---|
| `docker compose up -d --wait` | Sobe Postgres 18 (porta `DB_PORT`, padrão 5433) e LocalStack 4.14.0 (porta 4566) com as filas criadas |
| `docker compose down -v` | Derruba tudo e apaga o volume do Postgres |
| `bun run dev` | Sobe a API com reload |
| `bun run start` | Sobe a API sem reload |
| `bun run typecheck` | `tsc --noEmit` (TypeScript 6.0.3, modo estrito) |
| `bun test` | Todos os testes: unitários, integração, concorrência e multiprocesso (ver [Testes](#testes)) |
| `bun run test:unit` | Só os testes sem I/O |
| `bun run test:integration` | Só os testes contra Postgres e LocalStack reais |
| `bun run test:concurrency` | Só os cenários com paralelismo real no HTTP |
| `bun run test:multiprocess` | Só os testes com processos reais da aplicação |
| `docker compose --profile app up -d --build --wait` | Builda a imagem, aplica as migrations e sobe 3 réplicas (portas 3001–3003) |
| `bun run verify:replicas` | Verifica as réplicas de ponta a ponta (ver [Rodando várias instâncias](#rodando-várias-instâncias-docker)) |
| `bun run db:migrate` | Aplica as migrations pendentes (7: wallets, transações, ledger, coerência, inbox, outbox, ordem do outbox e correlação) |
| `bun run db:migrate:down` | Reverte a última migration |
| `bun run db:migration:create` | Cria uma migration em branco (SQL escrito à mão) |
| `bun run db:migration:list` | Lista as migrations executadas |

Para rodar as migrations no banco de testes: `NODE_ENV=test bun run db:migrate`. O Bun passa a carregar o `.env.test`, que aponta para `wagering_test`.

## API

| Método e rota | O que faz | Respostas principais |
|---|---|---|
| `POST /wallets` | Cria a wallet; com saldo inicial maior que zero, grava também a transação OPENING e o crédito no ledger | 201, 409 `WALLET_ALREADY_EXISTS`, 400 |
| `GET /wallets/:walletId` | Saldo e versão | 200, 404 |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | Lançamentos do mais recente para o mais antigo, com cursor opaco e estável | 200, 400 `INVALID_CURSOR`, 404 |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo gravado com o reconstruído pelo ledger | 200 (`consistent: true` ou `false`), 404 |
| `POST /wagering/transactions` | Submete BET, WIN, LOSS, REFUND ou ROLLBACK; o header `Idempotency-Key` é obrigatório | 200, 202, 422, 409, 404, 400, 503 |
| `GET /wagering/transactions/:transactionId` | Visão completa da transação | 200, 404 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | A mesma visão, pelo id do provedor | 200, 404 |
| `GET /health/live` | Processo vivo | 200 |
| `GET /health/ready` | Postgres e SQS alcançáveis | 200, 503 |
| `GET /metrics` | Métricas no formato do Prometheus | 200 |

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

**Status da submissão** (ARCHITECTURE.md, D27):

| Status | Quando |
|---|---|
| 200 | PROCESSED, inclusive no replay (`idempotentReplay: true`) |
| 202 | PENDING_REFERENCE: a referência ainda não chegou; o worker resolve quando ela chegar (D38) |
| 422 | Rejeição de negócio, com `code` = `failureCode` (por exemplo `INSUFFICIENT_FUNDS`), ou jogador que não é dono da wallet |
| 409 | Mesma `Idempotency-Key` com outro payload, ou mesmo id externo com outra key |
| 404 | Wallet inexistente |
| 400 | Payload, `Money` ou `Idempotency-Key` inválidos |
| 503 | Falha transitória (banco fora, lock timeout), com `Retry-After`; reenviar a mesma requisição é seguro |

O `amount` precisa ter exatamente 2 casas decimais (`"25.00"`).

```bash
# reconciliação: saldo gravado × saldo reconstruído pelo ledger, numa leitura em snapshot que não bloqueia escritas
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation
# {"walletId":"…","storedBalance":{"amount":"975.00","currency":"BRL"},"calculatedBalance":{…},"difference":{"amount":"0.00",…},"consistent":true,"checkedEntries":42}
```

Uma divergência volta 200 com `consistent: false`, nunca é corrigida, gera um log `error` (só `walletId`, `difference` e `checkedEntries`) e conta em `wagering_reconciliations_total{result="inconsistent"}` (ARCHITECTURE.md, D42).

## Mensageria (SQS)

Com `SQS_CONSUMER_ENABLED=true` (padrão no `.env.example`), o processo da API também consome `wager-transactions.fifo`. A mensagem é o envelope `WagerTransactionRequested`, com `MessageGroupId` = `walletId` e `MessageDeduplicationId` = `messageId` (contrato em ARCHITECTURE.md, D32):

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

O consumer trata cada tipo de erro de um jeito (D30):
- **Erros de negócio** (por exemplo, saldo insuficiente) viram transação REJECTED, e a mensagem recebe ack.
- **Erros transitórios** são retentados com backoff exponencial e só vão para a DLQ depois de `SQS_MAX_RECEIVE_COUNT` entregas (≈ 13,5 min).
- **Erros permanentes** (payload inválido, wallet inexistente, conflito de idempotência) vão direto para a DLQ com `errorCode`.

### Eventos publicados

Com `OUTBOX_PUBLISHER_ENABLED=true` (padrão no `.env.example`), os eventos do outbox (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) vão para `wager-events.fifo`, em ordem por wallet (ARCHITECTURE.md, D35):
- `MessageGroupId` = `walletId` e `MessageDeduplicationId` = `eventId`;
- corpo = envelope do evento;
- atributos `eventType`, `eventId`, `aggregateId`, `correlationId` e `version`.

Quem consome deve deduplicar por `eventId`.

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

## Observabilidade

**Logs:** JSON, uma linha por evento (D5, D47).
- **Campos de rastreio:** cada linha leva `correlationId` (do header `x-correlation-id` ou gerado) e, quando existem no caminho, `messageId`, `transactionId`, `walletId` e `providerId`. Isso vale para HTTP, consumer, publisher e worker.
- **O que nunca entra:** corpo, headers e saldos. Nos erros, os valores monetários das mensagens são mascarados.

```bash
bun run dev | bunx pino-pretty                                   # legível no terminal
bun run dev | grep '"correlationId":"refund-request-1"'          # tudo de uma requisição, inclusive os eventos do worker
```

**Health:** `GET /health/live` (processo vivo, sem consultar dependências) e `GET /health/ready` (Postgres e as três filas, com timeout; 503 se alguma falha) (D6).

**Métricas:** `GET /metrics` expõe o formato de texto do Prometheus, sem autenticação, como o health (ARCHITECTURE.md, D43 a D46). Todas as métricas próprias começam com `wagering_`, e as de processo (`process_*`, `nodejs_*`) vêm junto.

```bash
curl -s localhost:3000/metrics | grep '^wagering_' | grep -v _bucket
```

| Pergunta | PromQL |
|---|---|
| Transações por status | `sum by (status) (rate(wagering_transactions_total[5m]))` |
| Duplicatas detectadas | `sum by (type) (rate(wagering_duplicates_total[5m]))` |
| Retries | `sum by (component, reason) (rate(wagering_retries_total[5m]))` |
| Mensagens na DLQ | `max(wagering_sqs_queue_messages{queue="requests_dlq", state="visible"})` |
| Conflitos de lock | `sum by (type) (rate(wagering_lock_conflicts_total[5m]))` |
| Outbox lag | `max(wagering_outbox_oldest_pending_age_seconds)` |
| Latência p95 por origem | `histogram_quantile(0.95, sum by (le, source) (rate(wagering_processing_duration_seconds_bucket[5m])))` |
| Sonda do scrape falhando | `increase(wagering_metrics_probe_failures_total[5m]) > 0` |

Com várias instâncias, some os contadores e use `max` nos gauges, que são consultados no banco e no SQS e saem iguais em todas.

## Testes

| Suíte | Comando | O que cobre | Testes | Duração |
|---|---|---|---|---|
| Unitários | `bun run test:unit` | Domínio (Money, Wallet, ledger, regras de cada kind, transições, hash do payload, propriedade do ledger com seed fixa), regra de dependência entre camadas, config, serializer de erros e helpers do consumer. Não precisa da infra | 308 | 0,1 s |
| Integração | `bun run test:integration` | Migrations (up, down e up), cada constraint e trigger, coerência saldo × ledger × transação, repositórios, endpoints, consumer SQS (redelivery, crash entre commit e ack, retry, DLQ, shutdown), publisher e worker, reconciliação, métricas e logs | 185 | 41 s |
| Concorrência | `bun run test:concurrency` | Duas apostas de 80.00 sobre 100.00, a mesma aposta 50× em paralelo, wallet quente, wallets distintas em paralelo, REFUND × ROLLBACK, lock timeout | 8 | 5 s |
| Multiprocesso | `bun run test:multiprocess` | 3 processos reais da aplicação: mesma aposta e saldo disputado entre instâncias, consumers e publishers em processos diferentes, `kill -9` antes do commit, entre o commit e o ack e no meio da publicação, SIGTERM real, reinício com prova de consistência final | 10 | 33 s |
| Tudo | `bun test` | As quatro acima | 511 | 76 s |
| Tudo, arquivos em paralelo | `bun test --parallel` | Idem; os arquivos de integração continuam se revezando pelo advisory lock | 511 | 79 s |

As durações foram medidas em WSL2 (Ryzen 5 5500, 12 threads, 15 GB), com Postgres e LocalStack locais, e são indicativas. Todas as suítes, menos a unitária, precisam da infra de pé (`docker compose up -d --wait`); sem ela, o arquivo falha na hora com essa instrução.

- **Sem mocks de infraestrutura:** integração, concorrência e multiprocesso usam PostgreSQL e LocalStack reais. Depois de cada teste, todas as wallets do banco são conferidas: saldo = saldo reconstruído pelo ledger.
- **Banco separado:** o `bun test` define `NODE_ENV=test` e carrega o `.env.test` por cima do `.env`. Os testes usam o banco **`wagering_test`**, criado pelo init do Postgres, e não tocam no banco de desenvolvimento. O reset recusa bancos cujo nome não termine em `_test`.
- **Isolamento entre arquivos:** todo arquivo que usa a infra chama `useIntegrationEnvironment()` (`test/support/integration.ts`), que toma um advisory lock no Postgres durante o arquivo inteiro. Mesmo com `--parallel`, esses arquivos se revezam em vez de mexer nos dados uns dos outros. Os scripts nunca passam `--parallel`.
- **Limpeza sem desligar triggers:** cada arquivo chama `resetDatabase()`, que derruba e recria o schema (`DROP SCHEMA` + migrations) dentro do lock. O ledger é imutável, e nem os testes apagam linhas dele.
- **Filas próprias:** cada teste de mensageria cria filas FIFO próprias, com visibilidade curta, e as apaga no fim.
- **Processos reais** (`test/multiprocess`): cada teste sobe a aplicação como processos do sistema operacional (`bun src/main.ts`, o mesmo entrypoint da produção) em portas livres e espera o `/health/ready`.
  - A janela entre o commit e o ack é acertada por um proxy de teste entre o processo e o LocalStack (`test/support/sqs-fault-proxy.ts`), que segura o `DeleteMessage`; a aplicação não tem gancho para isso (D49).
  - Os processos são encerrados no `afterEach` e na saída do runner, e os logs de cada um ficam em `$TMPDIR/wagering-multiprocess/<execução>/`.
- **Concorrência** (`test/concurrency`): o cliente reenvia ao receber 503, respeitando o `Retry-After`, e cada cenário registra quantos 503 recebeu (resumo no fim da execução). O `.env.test` usa `DB_POOL_MAX=20` para haver paralelismo real no banco.

## Configuração

Toda a configuração vem de variáveis de ambiente, validadas na subida. Com algum valor inválido, a aplicação não sobe e lista os campos com problema. O Bun carrega o `.env` automaticamente, e o Compose lê o mesmo arquivo. Os valores do `.env.example` (`wagering`/`wagering` no Postgres, `test`/`test` no LocalStack) são padrões do ambiente local, não segredos; fora dele, as credenciais vêm do ambiente.

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
| `HEALTH_CHECK_TIMEOUT_MS` | 1000 | Timeout de cada dependência no `/health/ready` e de cada sonda do `/metrics` |

## Solução de problemas

- **Fila criada com `maxReceiveCount` antigo ou sem `wager-events.fifo`:** o LocalStack não persiste estado; `docker compose up -d --force-recreate --wait sqs` recria as filas com o script e o `.env` atuais.
- **Porta 5432 ou 5433 ocupada:** troque `DB_PORT` no `.env`.
- **O banco `wagering_test` não existe:** o init do Postgres só roda com o volume vazio. Rode `docker compose down -v && docker compose up -d --wait`.
- **Logs legíveis no terminal:** `bun run dev | bunx pino-pretty`.
- **Processos de teste órfãos** (só se o runner for morto com `kill -9` no meio de `test/multiprocess`): `pkill -f -- --wagering-test-instance`. O marcador só existe na linha de comando dos processos dos testes, então `bun run dev`, `bun run start` e as réplicas do compose não são afetados.
- **Portas 3001–3003 ocupadas para as réplicas:** use outra faixa, por exemplo `APP_PORTS=4001-4003 docker compose --profile app up -d --wait` e `REPLICA_PORTS=4001,4002,4003 bun run verify:replicas`.

## Documentação

O [ARCHITECTURE.md](ARCHITECTURE.md) tem:
- o [mapa de avaliação](ARCHITECTURE.md#1-mapa-de-avaliação), de cada critério para as decisões, o código e os testes;
- a [visão geral](ARCHITECTURE.md#2-visão-geral);
- as decisões D1–D53, com opções, trade-offs e evidências;
- o [desenho de autenticação](ARCHITECTURE.md#13-autenticação);
- as [limitações conhecidas](ARCHITECTURE.md#14-limitações-conhecidas).
