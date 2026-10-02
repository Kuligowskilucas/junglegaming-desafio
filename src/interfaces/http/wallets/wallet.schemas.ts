import { z } from "zod";

export const openWalletBody = z.strictObject({
  playerId: z.uuid(),
  initialBalance: z.strictObject({
    amount: z.string(),
    currency: z.string(),
  }),
});

export type OpenWalletBody = z.infer<typeof openWalletBody>;

export const walletIdParam = z.uuid();

export const ledgerQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type LedgerQuery = z.infer<typeof ledgerQuery>;
