import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { MissingIdempotencyKeyError } from "../errors/missing-idempotency-key.error";
import { RequestValidationError } from "../errors/request-validation.error";
import { idempotencyKeyHeader } from "./wager-transaction.schemas";

export const IdempotencyKey = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const header = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers["idempotency-key"];
  if (header === undefined || header === "") {
    throw new MissingIdempotencyKeyError();
  }
  const parsed = idempotencyKeyHeader.safeParse(header);
  if (!parsed.success) {
    throw new RequestValidationError(
      parsed.error.issues.map((issue) => ({ message: issue.message, path: ["headers", "idempotency-key"] })),
    );
  }
  return parsed.data;
});
