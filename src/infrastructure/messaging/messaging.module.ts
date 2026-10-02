import { SQSClient } from "@aws-sdk/client-sqs";
import { Module, type OnApplicationShutdown } from "@nestjs/common";
import { AppConfig } from "../config/app-config";
import { QueueUrlResolver } from "./queue-url-resolver";
import { SqsHealth } from "./sqs-health";
import { SqsQueueGateway } from "./sqs-queue-gateway";

@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new SQSClient({ region: config.sqs.region, endpoint: config.sqs.endpoint }),
    },
    QueueUrlResolver,
    SqsHealth,
    SqsQueueGateway,
  ],
  exports: [SQSClient, QueueUrlResolver, SqsHealth, SqsQueueGateway],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
