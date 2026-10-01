import { describe, expect, test } from "bun:test";
import { WagerTransactionPendingReference } from "../../../../src/domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../../../src/domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../../../src/domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../../../src/domain/events/wallet-balance-changed";
import { InvalidOperationError } from "../../../../src/domain/shared/domain-error";
import { FailureCode } from "../../../../src/domain/wagering/failure-code";
import { settleWagerTransaction } from "../../../../src/domain/wagering/wager-settlement";
import { WagerTransactionKind } from "../../../../src/domain/wagering/wager-transaction-kind";
import { at, aReversalOf, aTransaction, aWallet, brl, secondsAfter } from "../../../support/domain-builders";

const context = {
  eventId: "event-1",
  correlationId: "correlation-1",
  causationId: "msg-123",
  occurredAt: secondsAfter(1),
};

const transactionFields = {
  transactionId: "tx-bet-1",
  providerId: "provider-a",
  externalTransactionId: "bet-1",
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-1",
  gameId: "fortune-chimp",
};

function settled(kind: WagerTransactionKind, balance: string, amount = "25.00") {
  const wallet = aWallet({ balance: brl(balance) });
  const transaction = aTransaction(kind, { money: brl(amount) });
  const outcome = settleWagerTransaction({
    transaction,
    wallet,
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: "entry-1",
    at,
  });
  return { wallet, transaction, outcome };
}

describe("WalletBalanceChanged", () => {
  test("serializes the envelope and the movement with MoneyProps", () => {
    const { wallet, outcome } = settled(WagerTransactionKind.Bet, "100.00");
    const entry = outcome.status === "PROCESSED" ? outcome.entry : undefined;

    const event = WalletBalanceChanged.from(wallet, entry!, context);

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      eventId: "event-1",
      eventType: "WalletBalanceChanged",
      aggregateId: "wallet-1",
      correlationId: "correlation-1",
      causationId: "msg-123",
      occurredAt: "2026-01-01T00:00:01.000Z",
      version: 1,
      data: {
        walletId: "wallet-1",
        transactionId: "tx-bet-1",
        direction: "DEBIT",
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  test("refuses an entry that is not the latest movement of the wallet", () => {
    const { wallet, outcome } = settled(WagerTransactionKind.Bet, "100.00");
    const entry = outcome.status === "PROCESSED" ? outcome.entry : undefined;
    wallet.credit({ entryId: "entry-2", transactionId: "tx-2", money: brl("1.00"), at });

    expect(() => WalletBalanceChanged.from(wallet, entry!, context)).toThrow(InvalidOperationError);
  });
});

describe("WagerTransactionProcessed", () => {
  test("is emitted for any processed transaction, LOSS included", () => {
    const { transaction } = settled(WagerTransactionKind.Loss, "100.00", "0.00");

    const event = WagerTransactionProcessed.from(transaction, context);

    expect(event.eventType).toBe("WagerTransactionProcessed");
    expect(event.aggregateId).toBe(transaction.id);
    expect(JSON.parse(JSON.stringify(event)).data).toEqual({
      ...transactionFields,
      transactionId: "tx-loss-1",
      externalTransactionId: "loss-1",
      kind: "LOSS",
      money: { amount: "0.00", currency: "BRL" },
      balanceAfter: { amount: "100.00", currency: "BRL" },
      processedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("carries the resolved reference", () => {
    const wallet = aWallet();
    const bet = aTransaction(WagerTransactionKind.Bet);
    settleWagerTransaction({ transaction: bet, wallet, reference: undefined, referenceAlreadyReversed: false, ledgerEntryId: "e-1", at });
    const refund = aReversalOf(WagerTransactionKind.Refund, bet);
    settleWagerTransaction({ transaction: refund, wallet, reference: bet, referenceAlreadyReversed: false, ledgerEntryId: "e-2", at });

    expect(WagerTransactionProcessed.from(refund, context).data.referenceTransactionId).toBe(bet.id);
  });

  test("refuses a transaction that is not processed", () => {
    expect(() => WagerTransactionProcessed.from(aTransaction(WagerTransactionKind.Bet), context)).toThrow(
      InvalidOperationError,
    );
  });
});

describe("WagerTransactionRejected", () => {
  test("carries the failure code and the observed balance", () => {
    const { transaction } = settled(WagerTransactionKind.Bet, "10.00");

    const data = JSON.parse(JSON.stringify(WagerTransactionRejected.from(transaction, context))).data;

    expect(data).toEqual({
      ...transactionFields,
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      failureCode: FailureCode.InsufficientFunds,
      balance: { amount: "10.00", currency: "BRL" },
      rejectedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("refuses a transaction that is not rejected", () => {
    const { transaction } = settled(WagerTransactionKind.Bet, "100.00");

    expect(() => WagerTransactionRejected.from(transaction, context)).toThrow(InvalidOperationError);
  });
});

describe("WagerTransactionPendingReference", () => {
  test("carries the missing reference and the next attempt", () => {
    const rollback = aReversalOf(WagerTransactionKind.Rollback, aTransaction(WagerTransactionKind.Bet));
    settleWagerTransaction({
      transaction: rollback,
      wallet: aWallet(),
      reference: undefined,
      referenceAlreadyReversed: false,
      ledgerEntryId: "entry-1",
      at,
    });

    const data = WagerTransactionPendingReference.from(rollback, context).toJSON().data;

    expect(data.referenceExternalTransactionId).toBe("bet-1");
    expect(data.referenceAttempts).toBe(1);
    expect(data.nextAttemptAt).toBe("2026-01-01T00:00:01.000Z");
    expect(data.kind).toBe(WagerTransactionKind.Rollback);
  });

  test("refuses a transaction that is not waiting for its reference", () => {
    expect(() => WagerTransactionPendingReference.from(aTransaction(WagerTransactionKind.Bet), context)).toThrow(
      InvalidOperationError,
    );
  });
});

describe("IntegrationEvent envelope", () => {
  test("omits causationId when there is none", () => {
    const { transaction } = settled(WagerTransactionKind.Bet, "100.00");
    const { causationId, ...withoutCausation } = context;

    const envelope = WagerTransactionProcessed.from(transaction, withoutCausation).toJSON();

    expect("causationId" in envelope).toBe(false);
  });

  test("keeps data frozen and the occurrence date immutable", () => {
    const { transaction } = settled(WagerTransactionKind.Bet, "100.00");
    const event = WagerTransactionProcessed.from(transaction, context);

    event.occurredAt.setUTCFullYear(1999);

    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(event.occurredAt).toEqual(secondsAfter(1));
  });
});
