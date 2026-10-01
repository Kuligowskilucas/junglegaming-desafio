import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";

@Injectable()
export class QueueUrlResolver {
  private readonly urls = new Map<string, string>();

  constructor(private readonly client: SQSClient) {}

  async resolve(queueName: string, abortSignal?: AbortSignal): Promise<string> {
    const cached = this.urls.get(queueName);
    if (cached) {
      return cached;
    }
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }), {
      abortSignal,
    });
    if (!QueueUrl) {
      throw new Error(`Queue ${queueName} has no URL`);
    }
    this.urls.set(queueName, QueueUrl);
    return QueueUrl;
  }
}
