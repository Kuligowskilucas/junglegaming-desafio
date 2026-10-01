import { InvalidOperationError, InvariantViolationError } from "../shared/domain-error";

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

export class InvalidInboxStateError extends InvariantViolationError {
  constructor(messageId: string, consumerName: string) {
    super(`Inbox message ${messageId} of ${consumerName} was already processed`);
  }
}

export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  private readonly receivedAtTime: number;
  private processedAtTime: number | undefined;

  private constructor(state: InboxMessageState) {
    this.messageId = state.messageId;
    this.consumerName = state.consumerName;
    this.payloadHash = state.payloadHash;
    this.receivedAtTime = state.receivedAt.getTime();
    this.processedAtTime = state.processedAt?.getTime();
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const [field, value] of Object.entries({
      messageId: props.messageId,
      consumerName: props.consumerName,
      payloadHash: props.payloadHash,
    })) {
      if (value.trim() === "") {
        throw new InvalidOperationError(`Inbox ${field} must not be blank`);
      }
    }
    return new InboxMessage({ ...props, processedAt: undefined });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }

  get receivedAt(): Date {
    return new Date(this.receivedAtTime);
  }

  get processedAt(): Date | undefined {
    return this.processedAtTime === undefined ? undefined : new Date(this.processedAtTime);
  }

  isProcessed(): boolean {
    return this.processedAtTime !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxStateError(this.messageId, this.consumerName);
    }
    this.processedAtTime = at.getTime();
  }
}
