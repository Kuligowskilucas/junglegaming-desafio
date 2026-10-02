import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../../../src/domain/events/wallet-balance-changed";
import { InvalidOutboxStateError, OutboxMessage } from "../../../../src/domain/messaging/outbox-message";
import { at, aWallet, brl, secondsAfter } from "../../../support/domain-builders";

function enqueued(): OutboxMessage {
  const wallet = aWallet({ balance: brl("100.00") });
  const entry = wallet.debit({ entryId: "entry-1", transactionId: "tx-1", money: brl("25.00"), at });
  const event = WalletBalanceChanged.from(wallet, entry, {
    eventId: "event-1",
    correlationId: "correlation-1",
    occurredAt: at,
  });
  return OutboxMessage.enqueue(event);
}

describe("OutboxMessage.enqueue", () => {
  test("takes identity, type and serialized envelope from the event", () => {
    const message = enqueued();

    expect(message.id).toBe("event-1");
    expect(message.aggregateId).toBe("wallet-1");
    expect(message.orderingKey).toBe("wallet-1");
    expect(message.position).toBeUndefined();
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.occurredAt).toEqual(at);
    expect(message.payload).toMatchObject({ eventId: "event-1", eventType: "WalletBalanceChanged", version: 1 });
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.isPending()).toBe(true);
  });

  test("freezes the payload deeply", () => {
    const message = enqueued();

    expect(Object.isFrozen(message.payload)).toBe(true);
    expect(Object.isFrozen(message.payload.data)).toBe(true);
  });

  test("serializes to JSON without bigint or Money instances", () => {
    expect(JSON.parse(JSON.stringify(enqueued().payload)).data.balanceAfter).toEqual({
      amount: "75.00",
      currency: "BRL",
    });
  });
});

describe("OutboxMessage delivery", () => {
  test("is due immediately after enqueue", () => {
    expect(enqueued().isDue(at)).toBe(true);
  });

  test("backs off exponentially from 1s up to a 5 minute cap and never gives up", () => {
    const message = enqueued();
    const delaysInSeconds: number[] = [];

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      message.scheduleRetry(at);
      delaysInSeconds.push((message.nextAttemptAt!.getTime() - at.getTime()) / 1_000);
    }

    expect(delaysInSeconds).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]);
    expect(message.attempts).toBe(12);
    expect(message.isPending()).toBe(true);
  });

  test("is not due before the scheduled retry and is due from then on", () => {
    const message = enqueued();
    message.scheduleRetry(at);

    expect(message.isDue(secondsAfter(0.999))).toBe(false);
    expect(message.isDue(secondsAfter(1))).toBe(true);
  });

  test("is published once and is no longer due", () => {
    const message = enqueued();
    message.markPublished(secondsAfter(2));

    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(secondsAfter(2));
    expect(message.isDue(secondsAfter(10))).toBe(false);
    expect(() => message.markPublished(secondsAfter(3))).toThrow(InvalidOutboxStateError);
    expect(() => message.scheduleRetry(secondsAfter(3))).toThrow(InvalidOutboxStateError);
  });

  test("rehydrates a pending message with its retry schedule", () => {
    const message = OutboxMessage.rehydrate({
      id: "event-9",
      aggregateId: "wallet-1",
      orderingKey: "wallet-1",
      position: 9,
      eventType: "WalletBalanceChanged",
      payload: { eventId: "event-9" },
      occurredAt: at,
      attempts: 3,
      nextAttemptAt: secondsAfter(4),
      publishedAt: undefined,
    });

    expect(message.attempts).toBe(3);
    expect(message.isDue(secondsAfter(3))).toBe(false);
    expect(message.isDue(secondsAfter(4))).toBe(true);
  });
});
