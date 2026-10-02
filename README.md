# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) de múltiplos provedores, com idempotência persistente, ledger imutável e transactional outbox. O enunciado completo está em [`docs/DESAFIO.md`](docs/DESAFIO.md). As decisões técnicas e os trade-offs estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Status:** Etapas 1 a 4 concluídas: infra local, aplicação NestJS em Bun, config validada, logs JSON, health checks; o modelo de domínio (Money, Wallet, ledger, WagerTransaction, regras de BET/WIN/LOSS/REFUND/ROLLBACK, inbox, outbox e eventos); o schema PostgreSQL com as garantias no banco (constraints, índices e triggers), a persistência, os endpoints de wallet e a submissão de transações com idempotência, lock por wallet e outbox, testada com concorrência real.

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
| `bun run db:migrate` | Aplica as migrations pendentes (6: wallets, transações, ledger, coerência, inbox, outbox) |
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

Status da submissão (ARCHITECTURE.md, D27): 200 PROCESSED, 202 PENDING_REFERENCE (referência ainda não chegou), 422 rejeição de negócio (`code` = `failureCode`), 409 conflito de idempotência, 400 payload inválido, 503 com `Retry-After` para falha transitória (reenviar a mesma requisição é seguro).

O `amount` precisa ter exatamente 2 casas decimais (`"25.00"`). O ledger vem do lançamento mais recente para o mais antigo, e o cursor é opaco e estável mesmo com lançamentos novos chegando durante a paginação.

## Testes

- **Unitários** (`test/unit`) não fazem I/O e não precisam da infra: domínio (`test/unit/domain`, incluindo regras de negócio, transições de status, hash de payload e um teste de propriedade do ledger com seed fixa), regra de dependência entre camadas (`test/unit/architecture`) e config.
- **Integração** (`test/integration`) usam PostgreSQL e LocalStack reais, sem mocks: migrations (up → down passo a passo → up), cada constraint e trigger violado por SQL, a coerência saldo ↔ ledger ↔ transação no COMMIT, repositórios e os endpoints de wallet (atomicidade, 10 POSTs simultâneos, cursor estável). A infra precisa estar de pé (`docker compose up -d --wait`). Se não estiver, o teste falha na hora com essa instrução.
- O `bun test` define `NODE_ENV=test` e carrega o `.env.test` por cima do `.env`. Os testes usam o banco **`wagering_test`**, criado pelo init do Postgres, e não tocam no banco de desenvolvimento.
- **Sem paralelismo entre arquivos que limpam o banco.** O `bun test` roda os arquivos em série por padrão, e os scripts nunca passam `--parallel`. Além disso, todo arquivo de integração chama `useIntegrationEnvironment()` (`test/support/integration.ts`). Ela toma um advisory lock no Postgres (`pg_advisory_lock`) numa conexão dedicada durante o arquivo inteiro. Mesmo com `bun test --parallel`, os arquivos de integração esperam uns pelos outros em vez de mexer nos dados de outro teste.
- Cada arquivo fecha a sua app Nest e as suas conexões no `afterAll`, porque os arquivos dividem o mesmo processo.
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
| `SQS_MAX_RECEIVE_COUNT` | 5 | Entregas antes de a mensagem ir para a DLQ (usado na criação da fila) |
| `DB_LOCK_TIMEOUT_MS` | 2000 | Espera máxima pelo lock de uma wallet; além disso, 503 retryable |
| `HEALTH_CHECK_TIMEOUT_MS` | 1000 | Timeout de cada dependência no `/health/ready` |

## Solução de problemas

- **Porta 5432 ou 5433 ocupada:** troque `DB_PORT` no `.env`.
- **O banco `wagering_test` não existe:** o init do Postgres só roda com o volume vazio. Rode `docker compose down -v && docker compose up -d --wait`.
- **Logs legíveis no terminal:** `bun run dev | bunx pino-pretty`.
