import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

export const CorrelationId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const { id } = context.switchToHttp().getRequest<{ id?: unknown }>();
  return typeof id === "string" ? id : "";
});
