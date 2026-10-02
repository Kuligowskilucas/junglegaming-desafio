import type { IntegrationEvent } from "../events/integration-event";
import { InvariantViolationError } from "../shared/domain-error";
import { deepFreeze } from "../shared/deep-freeze";
import { type BackoffPolicy, nextAttemptAt } from "../shared/retry-backoff";

export const outboxRetryPolicy: BackoffPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
};

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  orderingKey: string;
  position: number | undefined;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

export class InvalidOutboxStateError extends InvariantViolationError {
  constructor(messageId: string, action: string) {
    super(`Outbox message ${messageId} was already published and cannot ${action}`);
  }
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly orderingKey: string;
  readonly position: number | undefined;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  private readonly occurredAtTime: number;
  private _attempts: number;
  private nextAttemptTime: number | undefined;
  private publishedAtTime: number | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.orderingKey = state.orderingKey;
    this.position = state.position;
    this.eventType = state.eventType;
    this.payload = deepFreeze(state.payload);
    this.occurredAtTime = state.occurredAt.getTime();
    this._attempts = state.attempts;
    this.nextAttemptTime = state.nextAttemptAt?.getTime();
    this.publishedAtTime = state.publishedAt?.getTime();
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      orderingKey: event.orderingKey,
      position: undefined,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: undefined,
      publishedAt: undefined,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get occurredAt(): Date {
    return new Date(this.occurredAtTime);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this.nextAttemptTime === undefined ? undefined : new Date(this.nextAttemptTime);
  }

  get publishedAt(): Date | undefined {
    return this.publishedAtTime === undefined ? undefined : new Date(this.publishedAtTime);
  }

  isPending(): boolean {
    return this.publishedAtTime === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this.nextAttemptTime === undefined || this.nextAttemptTime <= now.getTime());
  }

  markPublished(at: Date): void {
    this.assertPending("be published again");
    this.publishedAtTime = at.getTime();
    this.nextAttemptTime = undefined;
  }

  scheduleRetry(now: Date): void {
    this.assertPending("be retried");
    this._attempts += 1;
    this.nextAttemptTime = nextAttemptAt(outboxRetryPolicy, this._attempts, now).getTime();
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      throw new InvalidOutboxStateError(this.id, action);
    }
  }
}
