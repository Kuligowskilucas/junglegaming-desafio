import { describe, expect, test } from "bun:test";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error";
import { Money } from "../../../../src/domain/shared/money";
import { LedgerDirection } from "../../../../src/domain/wallet/ledger-direction";
import type { Wallet } from "../../../../src/domain/wallet/wallet";
import { FailureCode } from "../../../../src/domain/wagering/failure-code";
import {
  type SettlementInput,
  type SettlementOutcome,
  settleWagerTransaction,
} from "../../../../src/domain/wagering/wager-settlement";
import {
  InvalidTransactionStateError,
  referenceRetryPolicy,
  type WagerTransaction,
} from "../../../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../../src/domain/wagering/wager-transaction-status";
import {
  asRejected,
  at,
  aReversalOf,
  aTransaction,
  aWallet,
  brl,
  secondsAfter,
} from "../../../support/domain-builders";

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;
const { Processed, Rejected, PendingReference } = WagerTransactionStatus;

function settle(
  transaction: WagerTransaction,
  wallet: Wallet,
  options: Partial<Omit<SettlementInput, "transaction" | "wallet">> = {},
): SettlementOutcome {
  return settleWagerTransaction({
    transaction,
    wallet,
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: `entry-${transaction.id}`,
    at,
    ...options,
  });
}

function processedBet(wallet: Wallet, amount = "10.00", externalTransactionId = "bet-1"): WagerTransaction {
  const bet = aTransaction(Bet, { externalTransactionId, money: brl(amount) });
  expect(settle(bet, wallet).status).toBe(Processed);
  return bet;
}

function entryOf(outcome: SettlementOutcome) {
  if (outcome.status !== Processed || !outcome.entry) {
    throw new Error(`expected a processed outcome with a ledger entry, got ${JSON.stringify(outcome)}`);
  }
  return outcome.entry;
}

describe("BET", () => {
  test("debits the wallet and records one DEBIT entry", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const bet = aTransaction(Bet, { money: brl("25.00") });

    const entry = entryOf(settle(bet, wallet));

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.transactionId).toBe(bet.id);
    expect(entry.id).toBe(`entry-${bet.id}`);
    expect(wallet.balance.toJSON().amount).toBe("75.00");
    expect(bet.status).toBe(Processed);
    expect(bet.observedBalance?.toJSON().amount).toBe("75.00");
  });

  test("is rejected with INSUFFICIENT_FUNDS without touching the wallet", () => {
    const wallet = aWallet({ balance: brl("10.00") });
    const bet = aTransaction(Bet, { money: brl("10.01") });

    const outcome = settle(bet, wallet);

    expect(outcome).toEqual({ status: Rejected, code: FailureCode.InsufficientFunds });
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.observedBalance?.toJSON().amount).toBe("10.00");
    expect(wallet.balance.toJSON().amount).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  test("section 8 scenario: two bets of 80.00 on 100.00 leave exactly one debit and 20.00", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const first = aTransaction(Bet, { externalTransactionId: "bet-a", money: brl("80.00") });
    const second = aTransaction(Bet, { externalTransactionId: "bet-b", money: brl("80.00") });

    const outcomes = [settle(first, wallet), settle(second, wallet)];

    expect(outcomes.filter((outcome) => outcome.status === Processed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === Rejected)).toEqual([
      { status: Rejected, code: FailureCode.InsufficientFunds },
    ]);
    expect(outcomes.flatMap((outcome) => (outcome.status === Processed && outcome.entry ? [outcome.entry] : []))).toHaveLength(1);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });
});

describe("WIN", () => {
  test("credits the wallet", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const win = aTransaction(Win, { money: brl("50.00") });

    const entry = entryOf(settle(win, wallet));

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe("150.00");
  });

  test("may reference the processed BET of the same round", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const bet = processedBet(wallet);
    const win = aTransaction(Win, { referenceExternalTransactionId: bet.externalTransactionId, money: brl("30.00") });

    settle(win, wallet, { reference: bet });

    expect(win.status).toBe(Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe("120.00");
  });

  test("waits when the referenced BET has not arrived yet", () => {
    const wallet = aWallet();
    const win = aTransaction(Win, { referenceExternalTransactionId: "bet-late" });

    expect(settle(win, wallet)).toEqual({ status: PendingReference });
    expect(wallet.version).toBe(1);
  });
});

describe("LOSS", () => {
  test("is processed without moving the balance or writing the ledger", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const loss = aTransaction(Loss, { money: brl("0.00") });

    const outcome = settle(loss, wallet);

    expect(outcome).toEqual({ status: Processed, entry: undefined });
    expect(loss.status).toBe(Processed);
    expect(loss.observedBalance?.toJSON().amount).toBe("100.00");
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });
});

describe("REFUND", () => {
  test("credits back a processed BET", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const bet = processedBet(wallet, "40.00");
    const refund = aReversalOf(Refund, bet);

    const entry = entryOf(settle(refund, wallet, { reference: bet }));

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("only reverses BET", () => {
    const wallet = aWallet();
    const win = aTransaction(Win, { externalTransactionId: "win-1" });
    settle(win, wallet);

    expect(settle(aReversalOf(Refund, win), wallet, { reference: win })).toEqual({
      status: Rejected,
      code: FailureCode.ReferenceInvalidKind,
    });
  });

  test("must match the BET amount", () => {
    const wallet = aWallet();
    const bet = processedBet(wallet, "40.00");

    expect(settle(aReversalOf(Refund, bet, { money: brl("20.00") }), wallet, { reference: bet })).toEqual({
      status: Rejected,
      code: FailureCode.ReferenceAmountMismatch,
    });
  });

  test("reverses a BET only once", () => {
    const wallet = aWallet();
    const bet = processedBet(wallet);
    const secondRefund = aReversalOf(Refund, bet, { externalTransactionId: "refund-2" });

    const outcome = settle(secondRefund, wallet, { reference: bet, referenceAlreadyReversed: true });

    expect(outcome).toEqual({ status: Rejected, code: FailureCode.ReferenceAlreadyReversed });
    expect(wallet.balance.toJSON().amount).toBe("90.00");
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits it back", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const bet = processedBet(wallet, "40.00");

    const entry = entryOf(settle(aReversalOf(Rollback, bet), wallet, { reference: bet }));

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("of a WIN debits it back", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const win = aTransaction(Win, { externalTransactionId: "win-1", money: brl("30.00") });
    settle(win, wallet);

    const entry = entryOf(settle(aReversalOf(Rollback, win), wallet, { reference: win }));

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("of a REFUND debits the refund back", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const bet = processedBet(wallet, "40.00");
    const refund = aReversalOf(Refund, bet);
    settle(refund, wallet, { reference: bet });

    const entry = entryOf(settle(aReversalOf(Rollback, refund), wallet, { reference: refund }));

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe("60.00");
  });

  test("that would overdraw the wallet is rejected with its own code, not INSUFFICIENT_FUNDS", () => {
    const wallet = aWallet({ balance: brl("0.00") });
    const win = aTransaction(Win, { externalTransactionId: "win-1", money: brl("30.00") });
    settle(win, wallet);
    settle(aTransaction(Bet, { externalTransactionId: "bet-spend", money: brl("30.00") }), wallet);
    const rollback = aReversalOf(Rollback, win);

    const outcome = settle(rollback, wallet, { reference: win });

    expect(outcome).toEqual({ status: Rejected, code: FailureCode.ReversalInsufficientFunds });
    expect(rollback.status).toBe(Rejected);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test.each([Loss, Rollback])("cannot reverse a %s", (referenceKind) => {
    const wallet = aWallet();
    const bet = processedBet(wallet);
    const reference =
      referenceKind === Loss ? aTransaction(Loss, { externalTransactionId: "loss-1" }) : aReversalOf(Rollback, bet);
    settle(reference, wallet, { reference: referenceKind === Loss ? undefined : bet });

    expect(settle(aReversalOf(Rollback, reference), wallet, { reference })).toEqual({
      status: Rejected,
      code: FailureCode.ReferenceInvalidKind,
    });
  });

  test("reverses a reference only once, whatever reversed it before", () => {
    const wallet = aWallet();
    const bet = processedBet(wallet);
    settle(aReversalOf(Refund, bet), wallet, { reference: bet });

    expect(settle(aReversalOf(Rollback, bet), wallet, { reference: bet, referenceAlreadyReversed: true })).toEqual({
      status: Rejected,
      code: FailureCode.ReferenceAlreadyReversed,
    });
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });
});

describe("reference validation", () => {
  test.each<[string, Partial<{ playerId: string; walletId: string; roundId: string; money: Money }>]>([
    ["player", { playerId: "player-2" }],
    ["round", { roundId: "round-2" }],
    ["currency", { money: Money.from({ amount: "10.00", currency: "USD" }) }],
  ])("a reference from another %s is REFERENCE_MISMATCH", (_, change) => {
    const wallet = aWallet();
    const foreignBet = asRejected(aTransaction(Bet, { externalTransactionId: "bet-1", ...change }));
    const refund = aReversalOf(Refund, aTransaction(Bet, { externalTransactionId: "bet-1" }));

    expect(settle(refund, wallet, { reference: foreignBet })).toEqual({
      status: Rejected,
      code: FailureCode.ReferenceMismatch,
    });
  });

  test("a reference that ended REJECTED cannot be reversed", () => {
    const wallet = aWallet({ balance: brl("5.00") });
    const bet = aTransaction(Bet, { money: brl("10.00") });
    expect(settle(bet, wallet).status).toBe(Rejected);

    expect(settle(aReversalOf(Refund, bet), wallet, { reference: bet })).toEqual({
      status: Rejected,
      code: FailureCode.ReferenceNotProcessed,
    });
    expect(wallet.balance.toJSON().amount).toBe("5.00");
  });

  test("a reference still in flight makes the transaction wait", () => {
    const wallet = aWallet();
    const pendingBet = aTransaction(Bet);
    const refund = aReversalOf(Refund, pendingBet);

    expect(settle(refund, wallet, { reference: pendingBet })).toEqual({ status: PendingReference });
    expect(refund.referenceAttempts).toBe(1);
  });
});

describe("references delivered out of order", () => {
  test("a ROLLBACK that arrives before its BET waits, then applies once the BET is processed", () => {
    const wallet = aWallet({ balance: brl("100.00") });
    const bet = aTransaction(Bet, { money: brl("40.00") });
    const rollback = aReversalOf(Rollback, bet);

    expect(settle(rollback, wallet)).toEqual({ status: PendingReference });
    expect(rollback.status).toBe(PendingReference);
    expect(rollback.nextReferenceAttemptAt).toEqual(secondsAfter(1));
    expect(wallet.version).toBe(1);

    settle(bet, wallet, { at: secondsAfter(0.5) });
    const outcome = settle(rollback, wallet, { reference: bet, at: secondsAfter(1) });

    expect(entryOf(outcome).direction).toBe(LedgerDirection.Credit);
    expect(rollback.status).toBe(Processed);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("gives up with REFERENCE_NOT_FOUND after the retry limit", () => {
    const wallet = aWallet();
    const refund = aReversalOf(Refund, aTransaction(Bet, { externalTransactionId: "never-arrives" }));
    const outcomes: SettlementOutcome[] = [];

    for (let evaluation = 0; evaluation <= referenceRetryPolicy.maxAttempts; evaluation += 1) {
      outcomes.push(settle(refund, wallet, { at: secondsAfter(evaluation) }));
    }

    expect(outcomes.slice(0, -1).every((outcome) => outcome.status === PendingReference)).toBe(true);
    expect(outcomes.at(-1)).toEqual({ status: Rejected, code: FailureCode.ReferenceNotFound });
    expect(refund.referenceAttempts).toBe(referenceRetryPolicy.maxAttempts);
    expect(wallet.version).toBe(1);
  });

  test("gives up with REFERENCE_NOT_PROCESSED when the reference never settles", () => {
    const wallet = aWallet();
    const stuckBet = aTransaction(Bet);
    const refund = aReversalOf(Refund, stuckBet);

    for (let attempt = 0; attempt < referenceRetryPolicy.maxAttempts; attempt += 1) {
      settle(refund, wallet, { reference: stuckBet });
    }

    expect(settle(refund, wallet, { reference: stuckBet })).toEqual({
      status: Rejected,
      code: FailureCode.ReferenceNotProcessed,
    });
  });
});

describe("wallet checks", () => {
  test("a player that does not own the wallet is WALLET_PLAYER_MISMATCH", () => {
    const wallet = aWallet({ playerId: "player-2" });

    expect(settle(aTransaction(Bet), wallet)).toEqual({ status: Rejected, code: FailureCode.WalletPlayerMismatch });
    expect(wallet.version).toBe(1);
  });

  test("an operation in another currency is CURRENCY_MISMATCH", () => {
    const wallet = aWallet({ balance: Money.from({ amount: "100.00", currency: "USD" }) });

    expect(settle(aTransaction(Bet), wallet)).toEqual({ status: Rejected, code: FailureCode.CurrencyMismatch });
    expect(wallet.balance.toJSON()).toEqual({ amount: "100.00", currency: "USD" });
  });

  test("ownership is checked before currency", () => {
    const wallet = aWallet({ playerId: "player-2", balance: Money.from({ amount: "100.00", currency: "USD" }) });

    expect(settle(aTransaction(Bet), wallet)).toEqual({ status: Rejected, code: FailureCode.WalletPlayerMismatch });
  });
});

describe("programming errors", () => {
  test("settling a terminal transaction throws and leaves the wallet untouched", () => {
    const wallet = aWallet();
    const bet = processedBet(wallet);

    expect(() => settle(bet, wallet)).toThrow(InvalidTransactionStateError);
    expect(wallet.balance.toJSON().amount).toBe("90.00");
    expect(wallet.version).toBe(2);
  });

  test("settling against another wallet throws", () => {
    expect(() => settle(aTransaction(Bet), aWallet({ id: "wallet-2" }))).toThrow(InvalidOperationError);
  });

  test("passing a reference to a transaction without one throws", () => {
    const wallet = aWallet();
    const bet = processedBet(wallet);

    expect(() => settle(aTransaction(Win), wallet, { reference: bet })).toThrow(InvalidOperationError);
  });
});
