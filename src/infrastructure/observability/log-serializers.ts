const monetaryAmount = /-?\b\d+\.\d{2}\b/g;

export function maskAmounts(text: string): string {
  return text.replace(monetaryAmount, "[amount]");
}

export function serializeError(error: unknown): Record<string, string> {
  if (typeof error !== "object" || error === null) {
    return { type: typeof error, message: maskAmounts(String(error)) };
  }
  const { type, name, message, code, constraint, stack } = error as Record<string, unknown>;
  return {
    type: typeof type === "string" ? type : typeof name === "string" ? name : error.constructor.name,
    ...(typeof message === "string" ? { message: maskAmounts(message) } : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof constraint === "string" ? { constraint } : {}),
    ...(typeof stack === "string" ? { stack: maskAmounts(stack) } : {}),
  };
}
