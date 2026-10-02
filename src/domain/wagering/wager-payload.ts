import { type CanonicalJsonValue, canonicalHash, canonicalJson } from "../shared/canonical-json";
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

function businessFields(payload: WagerPayload): CanonicalJsonValue {
  const money = payload.money.toJSON();
  return {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: money.amount, currency: money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
}

export function canonicalWagerPayload(payload: WagerPayload): string {
  return canonicalJson(businessFields(payload));
}

export function hashWagerPayload(payload: WagerPayload): string {
  return canonicalHash(businessFields(payload));
}
