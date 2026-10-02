import { z } from "zod";

export const boundedText = z.string().min(1).max(128);

export const wagerTransactionPayloadFields = {
  providerId: boundedText,
  externalTransactionId: boundedText,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: boundedText,
  gameId: boundedText,
  kind: z.string().min(1).max(32),
  money: z.strictObject({
    amount: z.string(),
    currency: z.string(),
  }),
  referenceExternalTransactionId: boundedText.optional(),
};

export const idempotencyKeyFormat = z
  .string()
  .regex(/^[\x21-\x7E]{1,255}$/, "Must be 1 to 255 printable ASCII characters without spaces");
