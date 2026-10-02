import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

interface Replica {
  name: string;
  baseUrl: string;
}

interface Wallet {
  id: string;
  playerId: string;
}

const ports = (process.env.REPLICA_PORTS ?? "3001,3002,3003").split(",").map((port) => port.trim());
const replicas: Replica[] = ports.map((port, index) => ({ name: `replica ${index + 1} (:${port})`, baseUrl: `http://localhost:${port}` }));
const failures: string[] = [];
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1", endpoint: process.env.SQS_ENDPOINT });

function check(condition: boolean, description: string): void {
  console.info(`${condition ? "ok  " : "FAIL"}  ${description}`);
  if (!condition) {
    failures.push(description);
  }
}

async function request(replica: Replica, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${replica.baseUrl}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function openWallet(replica: Replica, amount: string): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const { status, body } = await request(replica, "POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  if (status !== 201) {
    throw new Error(`could not open a wallet on ${replica.name}: ${status} ${JSON.stringify(body)}`);
  }
  return { id: body.id as string, playerId };
}

function bet(wallet: Wallet, amount: string, externalTransactionId = `verify-${crypto.randomUUID()}`) {
  return {
    providerId: "provider-verify",
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "verify-round",
    gameId: "verify-game",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}

function submit(replica: Replica, payload: ReturnType<typeof bet>) {
  return request(replica, "POST", "/wagering/transactions", payload, {
    "idempotency-key": `${payload.providerId}:${payload.externalTransactionId}`,
  });
}

async function balanceOf(walletId: string): Promise<string> {
  const { body } = await request(replicas[0]!, "GET", `/wallets/${walletId}`);
  return (body.balance as { amount: string }).amount;
}

async function metricSum(replica: Replica, name: string, labels: Record<string, string> = {}): Promise<number> {
  const text = await (await fetch(`${replica.baseUrl}/metrics`)).text();
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `))
    .filter((line) => Object.entries(labels).every(([label, value]) => line.includes(`${label}="${value}"`)))
    .reduce((total, line) => total + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
}

async function waitFor(description: string, condition: () => Promise<boolean>, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await Bun.sleep(500);
  }
  console.info(`      timed out waiting for ${description}`);
  return false;
}

console.info(`Verifying ${replicas.length} replicas: ${replicas.map((replica) => replica.baseUrl).join(", ")}\n`);

for (const replica of replicas) {
  const ready = await request(replica, "GET", "/health/ready").catch(() => ({ status: 0, body: {} }));
  check(ready.status === 200, `${replica.name} is ready`);
}
if (failures.length > 0) {
  console.error("\nSome replicas are not ready; run `docker compose --profile app ps` and check the logs.");
  process.exit(1);
}

const touched: Wallet[] = [];

const sharedWallet = await openWallet(replicas[0]!, "100.00");
touched.push(sharedWallet);
const sameBet = bet(sharedWallet, "10.00");
const sameBetAnswers = await Promise.all(Array.from({ length: 30 }, (_, index) => submit(replicas[index % replicas.length]!, sameBet)));
check(
  sameBetAnswers.every((answer) => answer.status === 200) &&
    sameBetAnswers.filter((answer) => answer.body.idempotentReplay === false).length === 1 &&
    (await balanceOf(sharedWallet.id)) === "90.00",
  "the same bet sent 30 times across the replicas debits once",
);

const contested = await Promise.all(Array.from({ length: 5 }, (_, index) => openWallet(replicas[index % replicas.length]!, "100.00")));
touched.push(...contested);
const contestedAnswers = await Promise.all(
  contested.map((wallet, index) =>
    Promise.all([
      submit(replicas[index % replicas.length]!, bet(wallet, "80.00")),
      submit(replicas[(index + 1) % replicas.length]!, bet(wallet, "80.00")),
    ]),
  ),
);
const contestedBalances = await Promise.all(contested.map((wallet) => balanceOf(wallet.id)));
check(
  contestedAnswers.every((pair) => pair.map((answer) => answer.status).sort().join() === "200,422") &&
    contestedBalances.every((balance) => balance === "20.00"),
  "section 8 across replicas: one of two 80.00 bets on 100.00 is processed, the other rejected, balance 20.00",
);

const consumedBefore = await Promise.all(replicas.map((replica) => metricSum(replica, "wagering_transactions_total", { source: "sqs" })));
const messaged = await Promise.all(Array.from({ length: 10 }, (_, index) => openWallet(replicas[index % replicas.length]!, "100.00")));
touched.push(...messaged);
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: process.env.SQS_WAGER_QUEUE_NAME ?? "wager-transactions.fifo" }));
const envelopes = messaged.flatMap((wallet) =>
  Array.from({ length: 3 }, () => {
    const payload = bet(wallet, "1.00");
    return {
      messageId: `verify-${crypto.randomUUID()}`,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: { ...payload, idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}` },
    };
  }),
);
const sendEnvelope = (envelope: (typeof envelopes)[number], deduplicationId = envelope.messageId) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.data.walletId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
await Promise.all(envelopes.map((envelope) => sendEnvelope(envelope)));
await sendEnvelope(envelopes[0]!, crypto.randomUUID());
const consumed = await waitFor("the replicas to consume the messages", async () =>
  (await Promise.all(messaged.map((wallet) => balanceOf(wallet.id)))).every((balance) => balance === "97.00"),
);
check(consumed, `${envelopes.length} SQS messages (plus one redelivery) applied once each by the replicas' consumers`);

const published = await waitFor("the outbox to be published", async () =>
  (await Promise.all(replicas.map((replica) => metricSum(replica, "wagering_outbox_pending_events")))).every((pending) => pending === 0),
);
check(published, "every outbox event was published to the events queue");

const reconciliations = await Promise.all(
  touched.map((wallet, index) => request(replicas[index % replicas.length]!, "POST", `/wallets/${wallet.id}/reconciliation`)),
);
check(
  reconciliations.every((answer) => answer.status === 200 && answer.body.consistent === true),
  `${touched.length} wallets reconciled across the replicas, all consistent`,
);

console.info("\nWork per replica (from each replica's /metrics):");
let consumedByReplicas = 0;
for (const [index, replica] of replicas.entries()) {
  const http = await metricSum(replica, "wagering_transactions_total", { source: "http" });
  const sqsProcessed = (await metricSum(replica, "wagering_transactions_total", { source: "sqs" })) - consumedBefore[index]!;
  consumedByReplicas += sqsProcessed;
  const events = await metricSum(replica, "wagering_outbox_publication_delay_seconds_count");
  const duplicates = await metricSum(replica, "wagering_duplicates_total");
  console.info(
    `  ${replica.name}: ${http} HTTP transactions, ${sqsProcessed} SQS transactions in this run, ${events} events published, ${duplicates} duplicates detected`,
  );
}

if (consumedByReplicas < envelopes.length) {
  console.info(
    `  ${envelopes.length - consumedByReplicas} message(s) were consumed outside these replicas, for example by a \`bun run dev\` with the consumer enabled on the same queue`,
  );
}

sqs.destroy();
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.info("\nAll checks passed.");
