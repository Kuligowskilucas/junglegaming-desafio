import { z } from "zod";

const boundedText = z.string().min(1).max(128);

export const submitWagerTransactionBody = z.strictObject({
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
});

export type SubmitWagerTransactionBody = z.infer<typeof submitWagerTransactionBody>;

export const idempotencyKeyHeader = z.string().regex(/^[\x21-\x7E]{1,255}$/, "Must be 1 to 255 printable ASCII characters without spaces");

export const transactionIdParam = z.uuid();

export const providerIdParam = boundedText;

export const externalTransactionIdParam = boundedText;
