import { describe, expect, test } from "bun:test";
import { maskAmounts, serializeError } from "../../../src/infrastructure/observability/log-serializers";

describe("maskAmounts", () => {
  test("masks every monetary amount, signed or not", () => {
    expect(maskAmounts("wallet w-1 changed balance from 100.00 to -5.25 at version 3")).toBe(
      "wallet w-1 changed balance from [amount] to [amount] at version 3",
    );
  });

  test("keeps identifiers, versions, timestamps and source positions", () => {
    const text = "01a0fc54-bbca-7633 v1.4.2 11:12:21.754Z client.js:694:17 127.0.0.1";
    expect(maskAmounts(text)).toBe(text);
  });
});

describe("serializeError", () => {
  test("keeps type, message, code, constraint and stack and drops the rest of a database error", () => {
    const error = Object.assign(
      new Error("wallets_version_follows_balance: wallet w-1 changed balance from 100.00 to 90.00 so version must go from 2 to 3, got 2"),
      {
        name: "DriverException",
        code: "23514",
        constraint: "wallets_version_follows_balance",
        detail: "wallet_id=w-1 old_balance=100.00 new_balance=90.00",
        where: "PL/pgSQL function wallets_guard_update() line 9 at RAISE",
        parameters: ["w-1", "90.00"],
      },
    );

    const serialized = serializeError(error);

    expect(Object.keys(serialized).sort()).toEqual(["code", "constraint", "message", "stack", "type"]);
    expect(serialized).toMatchObject({
      type: "DriverException",
      code: "23514",
      constraint: "wallets_version_follows_balance",
      message:
        "wallets_version_follows_balance: wallet w-1 changed balance from [amount] to [amount] so version must go from 2 to 3, got 2",
    });
    expect(serialized.stack).not.toContain("100.00");
  });

  test("accepts the plain object pino-http hands over after its standard error serializer", () => {
    const standardSerialized = {
      type: "DriverException",
      message: "lock timeout while debiting 25.00",
      stack: "DriverException: lock timeout while debiting 25.00\n    at query (pg.js:1:1)",
      code: "55P03",
      detail: "Failing row contains (w-1, 25.00)",
      severity: "ERROR",
    };

    expect(serializeError(standardSerialized)).toEqual({
      type: "DriverException",
      message: "lock timeout while debiting [amount]",
      stack: "DriverException: lock timeout while debiting [amount]\n    at query (pg.js:1:1)",
      code: "55P03",
    });
  });

  test("ignores a non-string code such as a numeric errno", () => {
    expect(serializeError(Object.assign(new Error("boom"), { code: 57 }))).not.toContainKey("code");
  });

  test("describes thrown values that are not errors", () => {
    expect(serializeError("insufficient 10.00")).toEqual({ type: "string", message: "insufficient [amount]" });
  });
});
