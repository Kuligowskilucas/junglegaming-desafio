import { describe, expect, test } from "bun:test";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error";
import { InboxMessage, InvalidInboxStateError } from "../../../../src/domain/messaging/inbox-message";
import { at, secondsAfter } from "../../../support/domain-builders";

function received(): InboxMessage {
  return InboxMessage.receive({
    messageId: "msg-123",
    consumerName: "wager-transactions",
    payloadHash: "hash-1",
    receivedAt: at,
  });
}

describe("InboxMessage", () => {
  test("is received unprocessed", () => {
    const message = received();

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    expect(message.receivedAt).toEqual(at);
  });

  test("is marked processed once", () => {
    const message = received();

    message.markProcessed(secondsAfter(1));

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(secondsAfter(1));
    expect(() => message.markProcessed(secondsAfter(2))).toThrow(InvalidInboxStateError);
    expect(message.processedAt).toEqual(secondsAfter(1));
  });

  test("tells a redelivery from a different message reusing the id", () => {
    const message = received();

    expect(message.matchesPayload("hash-1")).toBe(true);
    expect(message.matchesPayload("hash-2")).toBe(false);
  });

  test.each(["messageId", "consumerName", "payloadHash"])("requires %s", (field) => {
    expect(() =>
      InboxMessage.receive({
        messageId: "msg-123",
        consumerName: "wager-transactions",
        payloadHash: "hash-1",
        receivedAt: at,
        [field]: " ",
      }),
    ).toThrow(InvalidOperationError);
  });

  test("rehydrates a processed message as is", () => {
    const message = InboxMessage.rehydrate({
      messageId: "msg-123",
      consumerName: "wager-transactions",
      payloadHash: "hash-1",
      receivedAt: at,
      processedAt: secondsAfter(1),
    });

    expect(message.isProcessed()).toBe(true);
  });
});
