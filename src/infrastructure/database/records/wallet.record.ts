import { defineEntity, type InferEntity, p } from "@mikro-orm/core";

export const WalletRecord = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string(),
    balance: p.decimal(),
    version: p.bigint("number"),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export type WalletRecord = InferEntity<typeof WalletRecord>;
