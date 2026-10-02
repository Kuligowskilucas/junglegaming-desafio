import { describe, expect, test } from "bun:test";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error";
import { Money } from "../../../../src/domain/shared/money";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction";
import { FailureCode } from "../../../../src/domain/wagering/failure-code";
import { hashWagerPayload } from "../../../../src/domain/wagering/wager-payload";
import {
  type CreateWagerTransactionProps,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  type InvalidWagerTransactionReason,
  referenceRetryPolicy,
  WagerTransaction,
} from "../../../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../../src/domain/wagering/wager-transaction-status";
import {
  asProcessed,
  at,
  aReversalOf,
  aTransaction,
  brl,
  secondsAfter,
} from "../../../support/domain-builders";

const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;

function creationFailureOf(kind: WagerTransactionKind, overrides: Partial<CreateWagerTransactionProps>) {
  try {
    aTransaction(kind, overrides);
  } catch (error) {
    if (error instanceof InvalidWagerTransactionError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error("expected InvalidWagerTransactionError");
}

describe("WagerTransaction.create", () => {
  test("is born PENDING with its own payload hash and no attempts", () => {
    const bet = aTransaction(Bet);

    expect(bet.status).toBe(WagerTransactionStatus.Pending);
    expect(bet.payloadHash).toBe(hashWagerPayload(bet));
    expect(bet.referenceAttempts).toBe(0);
    expect(bet.processedAt).toBeUndefined();
    expect(bet.failureCode).toBeUndefined();
    expect(bet.observedBalance).toBeUndefined();
    expect(bet.createdAt).toEqual(at);
    expect(bet.updatedAt).toEqual(at);
  });

  test.each<[string, WagerTransactionKind, Partial<CreateWagerTransactionProps>, InvalidWagerTransactionReason]>([
    ["OPENING submitted from outside", Opening, {}, "INTERNAL_KIND"],
    ["an unknown kind", "JACKPOT" as WagerTransactionKind, {}, "UNKNOWN_KIND"],
    ["the reserved internal provider", Bet, { providerId: "internal" }, "RESERVED_PROVIDER"],
    ["REFUND without reference", Refund, {}, "REFERENCE_REQUIRED"],
    ["ROLLBACK without reference", Rollback, {}, "REFERENCE_REQUIRED"],
    ["BET with reference", Bet, { referenceExternalTransactionId: "bet-0" }, "REFERENCE_NOT_ALLOWED"],
    ["a blank reference", Refund, { referenceExternalTransactionId: "  " }, "BLANK_FIELD"],
    ["a self reference", Refund, { externalTransactionId: "r-1", referenceExternalTransactionId: "r-1" }, "SELF_REFERENCE"],
    ["a zero BET", Bet, { money: brl("0.00") }, "NON_POSITIVE_AMOUNT"],
    ["a zero WIN", Win, { money: brl("0.00") }, "NON_POSITIVE_AMOUNT"],
    ["a negative LOSS", Loss, { money: brl("0.00").subtract(brl("1.00")) }, "NEGATIVE_AMOUNT"],
  ])("rejects %s", (_, kind, overrides, reason) => {
    expect(creationFailureOf(kind, overrides)).toBe(reason);
  });

  test.each(["id", "providerId", "externalTransactionId", "idempotencyKey", "correlationId", "playerId", "walletId", "roundId", "gameId"])(
    "rejects a blank %s",
    (field) => {
      expect(creationFailureOf(Bet, { [field]: " " })).toBe("BLANK_FIELD");
    },
  );

  test("accepts a LOSS of zero and optional references on WIN and LOSS", () => {
    expect(aTransaction(Loss, { money: brl("0.00") }).status).toBe(WagerTransactionStatus.Pending);
    expect(aTransaction(Win, { referenceExternalTransactionId: "bet-1" }).hasReference()).toBe(true);
    expect(aTransaction(Loss, { referenceExternalTransactionId: "bet-1" }).hasReference()).toBe(true);
  });
});

describe("WagerTransaction.opening", () => {
  test("is created already PROCESSED with reserved internal identifiers", () => {
    const opening = WagerTransaction.opening({
      id: "tx-opening",
      correlationId: "correlation-1",
      walletId: "wallet-1",
      playerId: "player-1",
      money: brl("1000.00"),
      at,
    });

    expect(opening.kind).toBe(Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.providerId).toBe("internal");
    expect(opening.externalTransactionId).toBe("opening:wallet-1");
    expect(opening.idempotencyKey).toBe("internal:opening:wallet-1");
    expect(opening.roundId).toBe("opening:wallet-1");
    expect(opening.gameId).toBe("wallet-opening");
    expect(opening.observedBalance?.toJSON().amount).toBe("1000.00");
    expect(opening.processedAt).toEqual(at);
    expect(opening.payloadHash).toBe(hashWagerPayload(opening));
    expect(opening.correlationId).toBe("correlation-1");
  });

  test("requires a positive amount", () => {
    expect(() =>
      WagerTransaction.opening({ id: "tx-opening", correlationId: "c", walletId: "wallet-1", playerId: "player-1", money: brl("0.00"), at }),
    ).toThrow(InvalidOperationError);
  });
});

describe("WagerTransactionStatus transitions", () => {
  const statesBuilders: Record<WagerTransactionStatus, () => WagerTransaction> = {
    [WagerTransactionStatus.Pending]: () => aReversalOf(Rollback, aTransaction(Bet)),
    [WagerTransactionStatus.PendingReference]: () => {
      const rollback = aReversalOf(Rollback, aTransaction(Bet));
      rollback.markPendingReference(at);
      return rollback;
    },
    [WagerTransactionStatus.Processed]: () => asProcessed(aReversalOf(Rollback, aTransaction(Bet))),
    [WagerTransactionStatus.Rejected]: () => {
      const rollback = aReversalOf(Rollback, aTransaction(Bet));
      rollback.reject(FailureCode.ReferenceNotFound, { at, observedBalance: brl("0.00") });
      return rollback;
    },
    [WagerTransactionStatus.Failed]: () => {
      const rollback = aReversalOf(Rollback, aTransaction(Bet));
      rollback.fail(FailureCode.ProcessingRetriesExhausted, at);
      return rollback;
    },
  };

  type Action = "markProcessed" | "markPendingReference" | "reject" | "fail";

  const actions: Record<Action, (transaction: WagerTransaction) => void> = {
    markProcessed: (transaction) =>
      transaction.markProcessed({ referenceTransactionId: "tx-bet-1", at, observedBalance: brl("10.00") }),
    markPendingReference: (transaction) => transaction.markPendingReference(at),
    reject: (transaction) =>
      transaction.reject(FailureCode.ReferenceNotFound, { at, observedBalance: brl("10.00") }),
    fail: (transaction) => transaction.fail(FailureCode.ProcessingRetriesExhausted, at),
  };

  const P = WagerTransactionStatus;
  const expected: Record<WagerTransactionStatus, Record<Action, WagerTransactionStatus | "error">> = {
    [P.Pending]: { markProcessed: P.Processed, markPendingReference: P.PendingReference, reject: P.Rejected, fail: P.Failed },
    [P.PendingReference]: { markProcessed: P.Processed, markPendingReference: P.PendingReference, reject: P.Rejected, fail: P.Failed },
    [P.Processed]: { markProcessed: "error", markPendingReference: "error", reject: "error", fail: "error" },
    [P.Rejected]: { markProcessed: "error", markPendingReference: "error", reject: "error", fail: "error" },
    [P.Failed]: { markProcessed: "error", markPendingReference: "error", reject: "error", fail: "error" },
  };

  const cases = Object.values(WagerTransactionStatus).flatMap((from) =>
    (Object.keys(actions) as Action[]).map((action) => [from, action, expected[from][action]] as const),
  );

  test.each(cases)("%s + %s → %s", (from, action, outcome) => {
    const transaction = statesBuilders[from]();
    expect(transaction.status).toBe(from);

    if (outcome === "error") {
      expect(() => actions[action](transaction)).toThrow(InvalidTransactionStateError);
      expect(transaction.status).toBe(from);
    } else {
      actions[action](transaction);
      expect(transaction.status).toBe(outcome);
    }
  });

  test("covers every status and action", () => {
    expect(cases).toHaveLength(20);
  });

  test("markProcessed records the outcome of the operation", () => {
    const refund = aReversalOf(Refund, asProcessed(aTransaction(Bet)));

    refund.markProcessed({ referenceTransactionId: "tx-bet-1", at: secondsAfter(5), observedBalance: brl("110.00") });

    expect(refund.referenceTransactionId).toBe("tx-bet-1");
    expect(refund.processedAt).toEqual(secondsAfter(5));
    expect(refund.updatedAt).toEqual(secondsAfter(5));
    expect(refund.observedBalance?.toJSON().amount).toBe("110.00");
  });

  test("markProcessed demands a resolved reference exactly when the payload has one", () => {
    expect(() =>
      aTransaction(Bet).markProcessed({ referenceTransactionId: "tx-x", at, observedBalance: brl("1.00") }),
    ).toThrow(InvalidOperationError);
    expect(() =>
      aReversalOf(Refund, aTransaction(Bet)).markProcessed({
        referenceTransactionId: undefined,
        at,
        observedBalance: brl("1.00"),
      }),
    ).toThrow(InvalidOperationError);
  });

  test("reject records the failure code and the balance observed at that moment", () => {
    const bet = aTransaction(Bet);

    bet.reject(FailureCode.InsufficientFunds, { at: secondsAfter(1), observedBalance: brl("20.00") });

    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.observedBalance?.toJSON().amount).toBe("20.00");
    expect(bet.updatedAt).toEqual(secondsAfter(1));
    expect(bet.processedAt).toBeUndefined();
  });

  test("markPendingReference is only for transactions that carry a reference", () => {
    expect(() => aTransaction(Bet).markPendingReference(at)).toThrow(InvalidOperationError);
  });
});

describe("PENDING_REFERENCE retry schedule", () => {
  test("backs off exponentially from 1s, caps at 60s and is exhausted after 8 attempts", () => {
    const rollback = aReversalOf(Rollback, aTransaction(Bet));
    const delaysInSeconds: number[] = [];

    for (let attempt = 1; attempt <= referenceRetryPolicy.maxAttempts; attempt += 1) {
      expect(rollback.referenceRetriesExhausted()).toBe(false);
      rollback.markPendingReference(at);
      delaysInSeconds.push((rollback.nextReferenceAttemptAt!.getTime() - at.getTime()) / 1_000);
    }

    expect(delaysInSeconds).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(rollback.referenceAttempts).toBe(8);
    expect(rollback.referenceRetriesExhausted()).toBe(true);
  });

  test("clears the schedule once the transaction is resolved", () => {
    const rollback = aReversalOf(Rollback, aTransaction(Bet));
    rollback.markPendingReference(at);

    rollback.markProcessed({ referenceTransactionId: "tx-bet-1", at, observedBalance: brl("1.00") });

    expect(rollback.nextReferenceAttemptAt).toBeUndefined();
  });
});

describe("WagerTransaction queries", () => {
  test("isTerminal is true only for PROCESSED, REJECTED and FAILED", () => {
    expect(aTransaction(Bet).isTerminal()).toBe(false);
    expect(asProcessed(aTransaction(Bet)).isTerminal()).toBe(true);
  });

  test.each([
    [Bet, true, false],
    [Win, true, false],
    [Loss, false, false],
    [Refund, true, true],
    [Rollback, true, true],
  ])("%s affectsBalance=%p requiresReference=%p", (kind, affectsBalance, requiresReference) => {
    const transaction =
      kind === Refund || kind === Rollback ? aReversalOf(kind, aTransaction(Bet)) : aTransaction(kind);

    expect(transaction.affectsBalance()).toBe(affectsBalance);
    expect(transaction.requiresReference()).toBe(requiresReference);
  });
});

describe("ledgerDirectionFor", () => {
  test.each([
    [Bet, LedgerDirection.Debit],
    [Win, LedgerDirection.Credit],
  ])("%s moves the balance as %s", (kind, direction) => {
    expect(aTransaction(kind).ledgerDirectionFor()).toBe(direction);
  });

  test("REFUND and OPENING are credits", () => {
    expect(aReversalOf(Refund, aTransaction(Bet)).ledgerDirectionFor(aTransaction(Bet))).toBe(LedgerDirection.Credit);
    expect(
      WagerTransaction.opening({ id: "o", correlationId: "c", walletId: "w", playerId: "p", money: brl("1.00"), at }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test("LOSS has no direction", () => {
    expect(() => aTransaction(Loss).ledgerDirectionFor()).toThrow(InvalidOperationError);
  });

  test.each([
    [Bet, LedgerDirection.Credit],
    [Win, LedgerDirection.Debit],
    [Refund, LedgerDirection.Debit],
  ])("ROLLBACK of %s is the inverse movement: %s", (referenceKind, direction) => {
    const reference =
      referenceKind === Refund ? aReversalOf(Refund, aTransaction(Bet)) : aTransaction(referenceKind);
    const rollback = aReversalOf(Rollback, reference);

    expect(rollback.ledgerDirectionFor(reference)).toBe(direction);
  });

  test("ROLLBACK without its reference cannot choose a direction", () => {
    expect(() => aReversalOf(Rollback, aTransaction(Bet)).ledgerDirectionFor()).toThrow(InvalidOperationError);
  });
});

describe("checkReference", () => {
  const bet = aTransaction(Bet, { externalTransactionId: "bet-1" });
  const win = aTransaction(Win, { externalTransactionId: "win-1" });
  const loss = aTransaction(Loss, { externalTransactionId: "loss-1" });
  const refund = aReversalOf(Refund, bet);
  const rollbackOfBet = aReversalOf(Rollback, bet);

  test.each([
    ["REFUND", "BET", aReversalOf(Refund, bet), bet, undefined],
    ["REFUND", "WIN", aReversalOf(Refund, win), win, FailureCode.ReferenceInvalidKind],
    ["ROLLBACK", "BET", aReversalOf(Rollback, bet), bet, undefined],
    ["ROLLBACK", "WIN", aReversalOf(Rollback, win), win, undefined],
    ["ROLLBACK", "REFUND", aReversalOf(Rollback, refund), refund, undefined],
    ["ROLLBACK", "LOSS", aReversalOf(Rollback, loss), loss, FailureCode.ReferenceInvalidKind],
    ["ROLLBACK", "ROLLBACK", aReversalOf(Rollback, rollbackOfBet), rollbackOfBet, FailureCode.ReferenceInvalidKind],
    ["WIN", "BET", aTransaction(Win, { referenceExternalTransactionId: "bet-1" }), bet, undefined],
    ["WIN", "WIN", aTransaction(Win, { externalTransactionId: "win-2", referenceExternalTransactionId: "win-1" }), win, FailureCode.ReferenceInvalidKind],
    ["LOSS", "BET", aTransaction(Loss, { referenceExternalTransactionId: "bet-1" }), bet, undefined],
  ])("%s referencing %s → %p", (_, __, transaction, reference, outcome) => {
    expect<FailureCode | undefined>(transaction.checkReference(reference)).toBe(outcome);
  });

  test.each<[string, Partial<CreateWagerTransactionProps>]>([
    ["player", { playerId: "player-2" }],
    ["wallet", { walletId: "wallet-2" }],
    ["round", { roundId: "round-2" }],
    ["currency", { money: Money.from({ amount: "10.00", currency: "USD" }) }],
  ])("a reference from another %s is a mismatch", (_, change) => {
    const foreignBet = aTransaction(Bet, { externalTransactionId: "bet-1", ...change });

    expect(aReversalOf(Refund, bet).checkReference(foreignBet)).toBe(FailureCode.ReferenceMismatch);
  });

  test("REFUND and ROLLBACK must match the referenced amount, WIN does not", () => {
    expect(aReversalOf(Refund, bet, { money: brl("9.99") }).checkReference(bet)).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
    expect(aReversalOf(Rollback, bet, { money: brl("10.01") }).checkReference(bet)).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
    expect(
      aTransaction(Win, { referenceExternalTransactionId: "bet-1", money: brl("50.00") }).checkReference(bet),
    ).toBeUndefined();
  });

  test("an invalid kind is reported before any mismatch", () => {
    const foreignWin = aTransaction(Win, { externalTransactionId: "win-1", roundId: "round-2" });

    expect(aReversalOf(Refund, win, { roundId: "round-1" }).checkReference(foreignWin)).toBe(
      FailureCode.ReferenceInvalidKind,
    );
  });

  test("refuses to compare against a transaction that is not the reference", () => {
    const otherBet = aTransaction(Bet, { externalTransactionId: "bet-2" });

    expect(() => aReversalOf(Refund, bet).checkReference(otherBet)).toThrow(InvalidOperationError);
    expect(() =>
      aReversalOf(Refund, bet).checkReference(aTransaction(Bet, { externalTransactionId: "bet-1", providerId: "provider-b" })),
    ).toThrow(InvalidOperationError);
  });
});

describe("WagerTransaction.rehydrate", () => {
  test("rebuilds a terminal transaction as persisted, without revalidating it", () => {
    const rejected = WagerTransaction.rehydrate({
      id: "tx-9",
      correlationId: "correlation-9",
      providerId: "provider-a",
      externalTransactionId: "bet-9",
      idempotencyKey: "provider-a:bet-9",
      payloadHash: "stored-hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: Bet,
      money: brl("80.00"),
      referenceExternalTransactionId: undefined,
      status: WagerTransactionStatus.Rejected,
      referenceTransactionId: undefined,
      failureCode: FailureCode.InsufficientFunds,
      observedBalance: brl("20.00"),
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
      createdAt: at,
      updatedAt: secondsAfter(1),
      processedAt: undefined,
    });

    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.payloadHash).toBe("stored-hash");
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected.matchesPayload("stored-hash")).toBe(true);
    expect(() => rejected.markProcessed({ referenceTransactionId: undefined, at, observedBalance: brl("1.00") })).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("hands out copies of its dates", () => {
    const bet = aTransaction(Bet);

    bet.createdAt.setUTCFullYear(1999);

    expect(bet.createdAt).toEqual(at);
  });
});
