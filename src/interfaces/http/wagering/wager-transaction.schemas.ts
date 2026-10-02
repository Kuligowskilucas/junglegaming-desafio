import { z } from "zod";
import { boundedText, idempotencyKeyFormat, wagerTransactionPayloadFields } from "../../wager-transaction-payload.schema";

export const submitWagerTransactionBody = z.strictObject(wagerTransactionPayloadFields);

export type SubmitWagerTransactionBody = z.infer<typeof submitWagerTransactionBody>;

export const idempotencyKeyHeader = idempotencyKeyFormat;

export const transactionIdParam = z.uuid();

export const providerIdParam = boundedText;

export const externalTransactionIdParam = boundedText;
