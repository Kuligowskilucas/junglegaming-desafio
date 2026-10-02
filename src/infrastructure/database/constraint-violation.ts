import { UniqueConstraintViolationException } from "@mikro-orm/core";

export function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    (error as UniqueConstraintViolationException & { constraint?: string }).constraint === constraint
  );
}
