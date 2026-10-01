import { SQSClient } from "@aws-sdk/client-sqs";
import { Module, type OnApplicationShutdown } from "@nestjs/common";
import { AppConfig } from "../config/app-config";
import { QueueUrlResolver } from "./queue-url-resolver";
import { SqsHealth } from "./sqs-health";

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
  ],
  exports: [SQSClient, QueueUrlResolver, SqsHealth],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
