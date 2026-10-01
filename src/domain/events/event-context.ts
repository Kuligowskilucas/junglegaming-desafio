export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}
