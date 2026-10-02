import { z } from "zod";

const cursorPayload = z.strictObject({
  w: z.string(),
  v: z.number().int().positive(),
});

export class InvalidCursorError extends Error {
  constructor() {
    super("The cursor is malformed or belongs to another wallet");
    this.name = "InvalidCursorError";
  }
}

export function encodeLedgerCursor(walletId: string, beforeWalletVersion: number): string {
  return Buffer.from(JSON.stringify({ w: walletId, v: beforeWalletVersion }), "utf8").toString("base64url");
}

export function decodeLedgerCursor(cursor: string, walletId: string): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = cursorPayload.safeParse(decoded);
  if (!parsed.success || parsed.data.w !== walletId) {
    throw new InvalidCursorError();
  }
  return parsed.data.v;
}
