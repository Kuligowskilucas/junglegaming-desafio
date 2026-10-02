import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { testConfig } from "./database";
import { type WalletHandle, wager } from "./wagering-client";

export interface TestQueues {
  queueName: string;
  deadLetterQueueName: string;
  queueUrl: string;
  deadLetterQueueUrl: string;
}

export interface RequestEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown> & { walletId: string; externalTransactionId: string };
}

export interface DeadLetter {
  body: string;
  attributes: Record<string, string>;
}

export function testSqsClient(): SQSClient {
  const config = testConfig();
  return new SQSClient({ region: config.sqs.region, endpoint: config.sqs.endpoint });
}

export async function createTestQueues(
  client: SQSClient,
  options: { visibilityTimeoutSeconds?: number; maxReceiveCount?: number } = {},
): Promise<TestQueues> {
  const suffix = Bun.randomUUIDv7();
  const deadLetterQueueName = `wager-test-${suffix}-dlq.fifo`;
  const queueName = `wager-test-${suffix}.fifo`;
  const { QueueUrl: deadLetterQueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: deadLetterQueueName, Attributes: { FifoQueue: "true" } }),
  );
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: deadLetterQueueUrl, AttributeNames: ["QueueArn"] }),
  );
  const { QueueUrl: queueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 2),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes?.QueueArn,
          maxReceiveCount: String(options.maxReceiveCount ?? 3),
        }),
      },
    }),
  );
  return { queueName, deadLetterQueueName, queueUrl: queueUrl!, deadLetterQueueUrl: deadLetterQueueUrl! };
}

export async function deleteTestQueues(client: SQSClient, queues: TestQueues): Promise<void> {
  await client.send(new DeleteQueueCommand({ QueueUrl: queues.queueUrl }));
  await client.send(new DeleteQueueCommand({ QueueUrl: queues.deadLetterQueueUrl }));
}

export function requestEnvelope(
  wallet: WalletHandle,
  kind: string,
  amount: string,
  overrides: Record<string, unknown> = {},
): RequestEnvelope {
  const payload = { ...wager(wallet, kind, amount), ...overrides };
  return {
    messageId: `msg-${Bun.randomUUIDv7()}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...payload, idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}` },
  };
}

export async function sendRaw(
  client: SQSClient,
  queueUrl: string,
  body: string,
  options: { groupId: string; deduplicationId?: string; correlationId?: string },
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId,
      MessageDeduplicationId: options.deduplicationId ?? Bun.randomUUIDv7(),
      MessageAttributes:
        options.correlationId === undefined
          ? undefined
          : { correlationId: { DataType: "String", StringValue: options.correlationId } },
    }),
  );
}

export function sendEnvelope(
  client: SQSClient,
  queueUrl: string,
  envelope: RequestEnvelope,
  options: { deduplicationId?: string; correlationId?: string } = {},
): Promise<void> {
  return sendRaw(client, queueUrl, JSON.stringify(envelope), {
    groupId: envelope.data.walletId,
    deduplicationId: options.deduplicationId ?? envelope.messageId,
    correlationId: options.correlationId,
  });
}

export async function queueDepth(client: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages ?? "0"),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0"),
  };
}

export async function drainDeadLetters(client: SQSClient, deadLetterQueueUrl: string, expected: number): Promise<DeadLetter[]> {
  const collected: DeadLetter[] = [];
  await waitUntil(
    async () => {
      const { Messages } = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: deadLetterQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ["All"],
        }),
      );
      for (const message of Messages ?? []) {
        collected.push({
          body: message.Body ?? "",
          attributes: Object.fromEntries(
            Object.entries(message.MessageAttributes ?? {}).map(([name, value]) => [name, value.StringValue ?? ""]),
          ),
        });
        await client.send(new DeleteMessageCommand({ QueueUrl: deadLetterQueueUrl, ReceiptHandle: message.ReceiptHandle }));
      }
      return collected.length >= expected;
    },
    { description: `${expected} dead letter(s)`, timeoutMs: 20_000 },
  );
  return collected;
}

export async function waitUntil(
  condition: () => Promise<boolean>,
  options: { description: string; timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(options.intervalMs ?? 100);
  }
  throw new Error(`Timed out waiting for ${options.description}`);
}
