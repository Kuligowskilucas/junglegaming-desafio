import { describe, expect, test } from "bun:test";
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from "../../../src/application/errors";
import { InvalidMoneyError } from "../../../src/domain/shared/money";
import { InvalidTransactionStateError } from "../../../src/domain/wagering/wager-transaction";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction-status";
import { classifyFailure } from "../../../src/interfaces/sqs/failure-classification";
import {
  InvalidMessageError,
  parseWagerTransactionMessage,
  toWagerTransactionRequest,
} from "../../../src/interfaces/sqs/wager-transaction-message";

const envelope = {
  messageId: "msg-123",
  type: "WagerTransactionRequested" as const,
  occurredAt: "2026-07-29T15:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  },
};

describe("parseWagerTransactionMessage", () => {
  test("accepts the envelope of section 10", () => {
    expect(parseWagerTransactionMessage(JSON.stringify(envelope))).toEqual(envelope);
  });

  test.each<[string, string]>([
    ["a body that is not JSON", "{oops"],
    ["an unknown type", JSON.stringify({ ...envelope, type: "SomethingElse" })],
    ["a missing messageId", JSON.stringify({ ...envelope, messageId: undefined })],
    ["a messageId longer than 128 characters", JSON.stringify({ ...envelope, messageId: "m".repeat(129) })],
    ["an occurredAt that is not ISO-8601", JSON.stringify({ ...envelope, occurredAt: "yesterday" })],
    ["a missing idempotencyKey", JSON.stringify({ ...envelope, data: { ...envelope.data, idempotencyKey: undefined } })],
    ["an unexpected field", JSON.stringify({ ...envelope, data: { ...envelope.data, extra: true } })],
  ])("rejects %s as INVALID_MESSAGE", (_, body) => {
    expect(() => parseWagerTransactionMessage(body)).toThrow(InvalidMessageError);
  });
});

describe("toWagerTransactionRequest", () => {
  const request = (value: typeof envelope) =>
    toWagerTransactionRequest(parseWagerTransactionMessage(JSON.stringify(value)), {
      consumerName: "consumer",
      correlationId: "corr",
    });

  test("splits the idempotency key from the payload", () => {
    const { idempotencyKey, payload, messageId } = request(envelope);

    expect(idempotencyKey).toBe("provider-a:transaction-123");
    expect(payload).not.toHaveProperty("idempotencyKey");
    expect(messageId).toBe("msg-123");
  });

  test("hashes the type and data, not the transport fields", () => {
    const original = request(envelope).payloadHash;

    expect(request({ ...envelope, messageId: "msg-456", occurredAt: "2026-07-30T00:00:00.000Z" }).payloadHash).toBe(original);
    expect(request({ ...envelope, data: { ...envelope.data, money: { amount: "25.01", currency: "BRL" } } }).payloadHash).not.toBe(original);
  });
});

describe("classifyFailure", () => {
  test.each<[string, unknown, string]>([
    ["an invalid envelope", new InvalidMessageError("bad"), "INVALID_MESSAGE"],
    ["an invalid amount", new InvalidMoneyError("INVALID_SCALE", "bad"), "INVALID_MONEY"],
    ["an unknown wallet", new WalletNotFoundError("w"), "WALLET_NOT_FOUND"],
    ["a foreign player", new WalletPlayerMismatchError("w", "p"), "WALLET_PLAYER_MISMATCH"],
    ["an idempotency conflict", new IdempotencyConflictError("p", "k", "t"), "IDEMPOTENCY_CONFLICT"],
    ["a duplicate external id", new DuplicateExternalTransactionError("p", "e", "t"), "DUPLICATE_EXTERNAL_TRANSACTION_ID"],
    ["a reused messageId", new InboxPayloadMismatchError("c", "m"), "INBOX_PAYLOAD_MISMATCH"],
  ])("treats %s as permanent", (_, error, code) => {
    expect(classifyFailure(error)).toMatchObject({ kind: "PERMANENT", code });
  });

  test("treats a lock timeout as transient", () => {
    expect(classifyFailure(Object.assign(new Error("lock"), { code: "55P03" }))).toEqual({
      kind: "TRANSIENT",
      code: "DEPENDENCY_UNAVAILABLE",
    });
  });

  test("treats an unexpected error as transient, so it is retried and never dropped", () => {
    expect(classifyFailure(new InvalidTransactionStateError("t", WagerTransactionStatus.Processed, "x"))).toEqual({
      kind: "TRANSIENT",
      code: "UNEXPECTED_ERROR",
    });
  });
});
