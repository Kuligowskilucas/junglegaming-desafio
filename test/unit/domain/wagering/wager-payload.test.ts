import { describe, expect, test } from "bun:test";
import { InvalidMoneyError, Money } from "../../../../src/domain/shared/money";
import {
  canonicalWagerPayload,
  hashWagerPayload,
  type WagerPayload,
} from "../../../../src/domain/wagering/wager-payload";
import { WagerTransactionKind } from "../../../../src/domain/wagering/wager-transaction-kind";
import { aTransaction, brl } from "../../../support/domain-builders";

const betFromChallenge: WagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: WagerTransactionKind.Bet,
  money: brl("25.00"),
};

describe("canonical wager payload", () => {
  test("sorts keys, drops whitespace and omits absent references", () => {
    expect(canonicalWagerPayload(betFromChallenge)).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
        '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
  });

  test("escapes string content through JSON rules", () => {
    const canonical = canonicalWagerPayload({ ...betFromChallenge, gameId: 'fortune "chimp"\n' });

    expect(canonical).toContain('"gameId":"fortune \\"chimp\\"\\n"');
  });
});

describe("hashWagerPayload", () => {
  test("matches the golden SHA-256 of the challenge example, locking the algorithm", () => {
    expect(hashWagerPayload(betFromChallenge)).toBe(
      "629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344",
    );
  });

  test("matches the golden SHA-256 of a payload with a reference", () => {
    const rollback: WagerPayload = {
      ...betFromChallenge,
      externalTransactionId: "rollback-9",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "transaction-123",
    };

    expect(hashWagerPayload(rollback)).toBe("2161285e32317399c12cb4d210cafe95da692ebd65b70983cb3f1b1b4a52dd5b");
  });

  test("ignores property order and transport metadata", () => {
    const reordered = Object.fromEntries(Object.entries(betFromChallenge).reverse()) as unknown as WagerPayload;
    const withTransportFields = {
      ...betFromChallenge,
      idempotencyKey: "another-key",
      messageId: "msg-123",
      occurredAt: "2026-07-29T15:00:00.000Z",
    };

    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(betFromChallenge));
    expect(hashWagerPayload(withTransportFields)).toBe(hashWagerPayload(betFromChallenge));
  });

  test.each<[string, Partial<WagerPayload>]>([
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "transaction-124" }],
    ["playerId", { playerId: "player-2" }],
    ["walletId", { walletId: "wallet-2" }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "other-game" }],
    ["kind", { kind: WagerTransactionKind.Win }],
    ["amount", { money: brl("25.01") }],
    ["currency", { money: Money.from({ amount: "25.00", currency: "USD" }) }],
    ["reference", { referenceExternalTransactionId: "transaction-100" }],
  ])("changes when %s changes", (_, change) => {
    expect(hashWagerPayload({ ...betFromChallenge, ...change })).not.toBe(hashWagerPayload(betFromChallenge));
  });

  test("never sees an amount without exactly 2 decimals, because Money rejects 25.5", () => {
    expect(() => Money.from({ amount: "25.5", currency: "BRL" })).toThrow(InvalidMoneyError);
  });
});

describe("idempotency key with divergent payload", () => {
  test("the same key with the same business payload is a replay", () => {
    const original = aTransaction(WagerTransactionKind.Bet, { money: brl("25.00") });
    const retry = aTransaction(WagerTransactionKind.Bet, { money: brl("25.00"), id: "tx-other-attempt" });

    expect(retry.idempotencyKey).toBe(original.idempotencyKey);
    expect(original.matchesPayload(retry.payloadHash)).toBe(true);
  });

  test("the same key with a different amount is a conflict, not a replay", () => {
    const original = aTransaction(WagerTransactionKind.Bet, { money: brl("25.00") });
    const divergent = aTransaction(WagerTransactionKind.Bet, { money: brl("26.00") });

    expect(divergent.idempotencyKey).toBe(original.idempotencyKey);
    expect(original.matchesPayload(divergent.payloadHash)).toBe(false);
  });

  test("the transaction computes its own hash from its fields", () => {
    const transaction = aTransaction(WagerTransactionKind.Bet);

    expect(transaction.payloadHash).toBe(hashWagerPayload(transaction));
  });
});
