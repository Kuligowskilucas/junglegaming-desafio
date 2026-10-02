import { z } from "zod";
import type { WagerTransactionRequest } from "../../application/messaging/handle-wager-transaction-requested";
import { canonicalHash } from "../../domain/shared/canonical-json";
import { idempotencyKeyFormat, wagerTransactionPayloadFields } from "../wager-transaction-payload.schema";

const wagerTransactionRequestedEnvelope = z.strictObject({
  messageId: z.string().min(1).max(128),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.strictObject({ ...wagerTransactionPayloadFields, idempotencyKey: idempotencyKeyFormat }),
});

export type WagerTransactionRequestedEnvelope = z.infer<typeof wagerTransactionRequestedEnvelope>;

export class InvalidMessageError extends Error {
  readonly code = "INVALID_MESSAGE";

  constructor(detail: string) {
    super(detail);
    this.name = "InvalidMessageError";
  }
}

export function parseWagerTransactionMessage(body: string): WagerTransactionRequestedEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new InvalidMessageError("The message body is not valid JSON");
  }
  const parsed = wagerTransactionRequestedEnvelope.safeParse(decoded);
  if (!parsed.success) {
    throw new InvalidMessageError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}

export function toWagerTransactionRequest(
  envelope: WagerTransactionRequestedEnvelope,
  context: { consumerName: string; correlationId: string },
): WagerTransactionRequest {
  const { idempotencyKey, ...payload } = envelope.data;
  return {
    consumerName: context.consumerName,
    messageId: envelope.messageId,
    payloadHash: canonicalHash({ type: envelope.type, data: envelope.data }),
    idempotencyKey,
    payload,
    correlationId: context.correlationId,
  };
}
