import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";
import { QueueUrlResolver } from "./queue-url-resolver";

export interface ReceivedMessage {
  sqsMessageId: string;
  receiptHandle: string;
  body: string;
  groupId: string | undefined;
  receiveCount: number;
  attributes: Readonly<Record<string, string>>;
}

export interface OutgoingMessage {
  body: string;
  groupId: string;
  deduplicationId: string;
  attributes?: Readonly<Record<string, string>>;
}

@Injectable()
export class SqsQueueGateway {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrls: QueueUrlResolver,
  ) {}

  async receive(
    queueName: string,
    options: { maxMessages: number; waitTimeSeconds: number; abortSignal?: AbortSignal },
  ): Promise<ReceivedMessage[]> {
    const { Messages } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrls.resolve(queueName, options.abortSignal),
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitTimeSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        MessageAttributeNames: ["All"],
      }),
      { abortSignal: options.abortSignal },
    );
    return (Messages ?? []).flatMap((message) =>
      message.MessageId && message.ReceiptHandle
        ? [
            {
              sqsMessageId: message.MessageId,
              receiptHandle: message.ReceiptHandle,
              body: message.Body ?? "",
              groupId: message.Attributes?.MessageGroupId,
              receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? "1"),
              attributes: Object.fromEntries(
                Object.entries(message.MessageAttributes ?? {}).flatMap(([name, value]) =>
                  value.StringValue === undefined ? [] : [[name, value.StringValue]],
                ),
              ),
            },
          ]
        : [],
    );
  }

  async delete(queueName: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: await this.queueUrls.resolve(queueName), ReceiptHandle: receiptHandle }),
    );
  }

  async changeVisibility(queueName: string, receiptHandle: string, visibilityTimeoutSeconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrls.resolve(queueName),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  async send(queueName: string, message: OutgoingMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrls.resolve(queueName),
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.deduplicationId,
        MessageAttributes: Object.fromEntries(
          Object.entries(message.attributes ?? {}).map(([name, value]) => [name, { DataType: "String", StringValue: value }]),
        ),
      }),
    );
  }
}
