import { Money } from "../../src/domain/shared/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { type CreateWagerTransactionProps, WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import type { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind";

export const at = new Date("2026-01-01T00:00:00.000Z");

export function secondsAfter(seconds: number, from: Date = at): Date {
  return new Date(from.getTime() + seconds * 1_000);
}

export function brl(amount: string): Money {
  return Money.from({ amount, currency: "BRL" });
}

export function aWallet(
  overrides: Partial<{ id: string; playerId: string; balance: Money; version: number }> = {},
): Wallet {
  const balance = overrides.balance ?? brl("100.00");
  return Wallet.rehydrate({
    id: overrides.id ?? "wallet-1",
    playerId: overrides.playerId ?? "player-1",
    currency: balance.currency,
    balance,
    version: overrides.version ?? 1,
    createdAt: at,
    updatedAt: at,
  });
}

export function aTransaction(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const providerId = overrides.providerId ?? "provider-a";
  const externalTransactionId = overrides.externalTransactionId ?? `${kind.toLowerCase()}-1`;
  return WagerTransaction.create({
    id: `tx-${externalTransactionId}`,
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: brl("10.00"),
    createdAt: at,
    ...overrides,
  });
}

export function aReversalOf(
  kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  reference: WagerTransaction,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return aTransaction(kind, {
    externalTransactionId: `${kind.toLowerCase()}-of-${reference.externalTransactionId}`,
    referenceExternalTransactionId: reference.externalTransactionId,
    providerId: reference.providerId,
    playerId: reference.playerId,
    walletId: reference.walletId,
    roundId: reference.roundId,
    money: reference.money,
    ...overrides,
  });
}

export function asProcessed(transaction: WagerTransaction): WagerTransaction {
  transaction.markProcessed({
    referenceTransactionId: transaction.hasReference() ? "tx-resolved-reference" : undefined,
    at,
    observedBalance: brl("0.00"),
  });
  return transaction;
}

export function asRejected(transaction: WagerTransaction): WagerTransaction {
  transaction.reject(FailureCode.InsufficientFunds, { at, observedBalance: brl("0.00") });
  return transaction;
}
