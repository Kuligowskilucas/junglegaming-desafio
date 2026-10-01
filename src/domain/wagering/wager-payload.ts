import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonical-json";
import type { Money } from "../shared/money";
import type { WagerTransactionKind } from "./wager-transaction-kind";

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

export function canonicalWagerPayload(payload: WagerPayload): string {
  const money = payload.money.toJSON();
  return canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: money.amount, currency: money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}

export function hashWagerPayload(payload: WagerPayload): string {
  return createHash("sha256").update(canonicalWagerPayload(payload), "utf8").digest("hex");
}
