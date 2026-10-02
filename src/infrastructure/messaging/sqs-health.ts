import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";
import { AppConfig } from "../config/app-config";
import { QueueUrlResolver } from "./queue-url-resolver";

@Injectable()
export class SqsHealth {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrls: QueueUrlResolver,
    private readonly config: AppConfig,
  ) {}

  async check(abortSignal: AbortSignal): Promise<void> {
    const queueNames = [
      this.config.sqs.wagerQueueName,
      this.config.sqs.wagerDeadLetterQueueName,
      this.config.sqs.eventsQueueName,
    ];
    await Promise.all(queueNames.map((queueName) => this.assertQueueReachable(queueName, abortSignal)));
  }

  private async assertQueueReachable(queueName: string, abortSignal: AbortSignal): Promise<void> {
    const queueUrl = await this.queueUrls.resolve(queueName, abortSignal);
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
      { abortSignal },
    );
  }
}
