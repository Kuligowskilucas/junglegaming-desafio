import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";
import { QueueUrlResolver } from "./queue-url-resolver";

export interface QueueDepth {
  visible: number;
  inFlight: number;
}

@Injectable()
export class SqsQueueDepthProbe {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrls: QueueUrlResolver,
  ) {}

  async depth(queueName: string, abortSignal: AbortSignal): Promise<QueueDepth> {
    const { Attributes } = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.queueUrls.resolve(queueName, abortSignal),
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
      { abortSignal },
    );
    return {
      visible: Number(Attributes?.ApproximateNumberOfMessages ?? "0"),
      inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0"),
    };
  }
}
