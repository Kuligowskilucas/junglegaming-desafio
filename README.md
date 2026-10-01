# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) de múltiplos provedores, com idempotência persistente, ledger imutável e transactional outbox. O enunciado completo está em [`docs/DESAFIO.md`](docs/DESAFIO.md). As decisões técnicas e os trade-offs estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Status:** Etapa 1 (fundação) concluída: infra local, aplicação NestJS em Bun, config validada, MikroORM com migrations, health checks, logs JSON e testes contra a infra real.

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
| `bun run test:unit` | Só os testes sem I/O |
| `bun run test:integration` | Só os testes contra Postgres e SQS reais |
| `bun run db:migrate` | Aplica as migrations pendentes |
| `bun run db:migrate:down` | Reverte a última migration |
| `bun run db:migration:create` | Cria uma migration em branco (SQL escrito à mão) |
| `bun run db:migration:list` | Lista as migrations executadas |

Para rodar as migrations no banco de testes: `NODE_ENV=test bun run db:migrate`. O Bun passa a carregar o `.env.test`, que aponta para `wagering_test`.

## Testes

- **Unitários** (`test/unit`) não fazem I/O.
- **Integração** (`test/integration`) usam PostgreSQL e LocalStack reais, sem mocks. A infra precisa estar de pé (`docker compose up -d --wait`). Se não estiver, o teste falha na hora com essa instrução.
- O `bun test` define `NODE_ENV=test` e carrega o `.env.test` por cima do `.env`. Os testes usam o banco **`wagering_test`**, criado pelo init do Postgres, e não tocam no banco de desenvolvimento.
- **Sem paralelismo entre arquivos que limpam o banco.** O `bun test` roda os arquivos em série por padrão, e os scripts nunca passam `--parallel`. Além disso, todo arquivo de integração chama `useIntegrationEnvironment()` (`test/support/integration.ts`). Ela toma um advisory lock no Postgres (`pg_advisory_lock`) numa conexão dedicada durante o arquivo inteiro. Mesmo com `bun test --parallel`, os arquivos de integração esperam uns pelos outros em vez de mexer nos dados de outro teste.
- Cada arquivo fecha a sua app Nest e as suas conexões no `afterAll`, porque os arquivos dividem o mesmo processo.

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
| `HEALTH_CHECK_TIMEOUT_MS` | 1000 | Timeout de cada dependência no `/health/ready` |

## Solução de problemas

- **Porta 5432 ou 5433 ocupada:** troque `DB_PORT` no `.env`.
- **O banco `wagering_test` não existe:** o init do Postgres só roda com o volume vazio. Rode `docker compose down -v && docker compose up -d --wait`.
- **Logs legíveis no terminal:** `bun run dev | bunx pino-pretty`.
