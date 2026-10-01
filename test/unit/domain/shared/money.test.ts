import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  type InvalidMoneyReason,
  Money,
} from "../../../../src/domain/shared/money";

function brl(amount: string): Money {
  return Money.from({ amount, currency: "BRL" });
}

function rejectionReasonOf(amount: unknown, currency: unknown = "BRL"): InvalidMoneyReason {
  try {
    Money.from({ amount, currency } as { amount: string; currency: string });
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error(`expected ${String(amount)} ${String(currency)} to be rejected`);
}

describe("Money.from", () => {
  test.each(["0.00", "0.01", "25.00", "975.50", "99999999999999999.99"])("accepts %p and serializes it unchanged", (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: "BRL" });
  });

  test.each(["25", "25.5", "0.1", "10.005", "1.999", "0.000"])(
    "rejects %p because the scale is not exactly 2 instead of rounding it",
    (amount) => {
      expect(rejectionReasonOf(amount)).toBe("INVALID_SCALE");
    },
  );

  test.each(["-5.00", "-0.00", "-0.01", "-25"])("rejects the negative amount %p", (amount) => {
    expect(rejectionReasonOf(amount)).toBe("NEGATIVE_AMOUNT");
  });

  test.each([
    "",
    " ",
    " 25.00",
    "25.00 ",
    "+25.00",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e3",
    "2.5e1",
    "0x10",
    "25,00",
    "25.",
    ".50",
    "025.00",
    "00.00",
    "１.00",
    "25.00BRL",
  ])("rejects the malformed amount %p", (amount) => {
    expect(rejectionReasonOf(amount)).toBe("INVALID_FORMAT");
  });

  test.each([25, 25.5, null, undefined, {}])("rejects the non-string amount %p", (amount) => {
    expect(rejectionReasonOf(amount)).toBe("INVALID_FORMAT");
  });

  test("rejects amounts beyond 17 integer digits", () => {
    expect(rejectionReasonOf("100000000000000000.00")).toBe("OUT_OF_RANGE");
  });

  test.each(["brl", "BR", "BRLX", "", "R$", "B1L", 986])("rejects the currency %p", (currency) => {
    expect(rejectionReasonOf("1.00", currency)).toBe("INVALID_CURRENCY");
  });
});

describe("Money arithmetic", () => {
  test("adds without floating point drift", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
  });

  test("keeps the exact sum of one thousand cents", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i += 1) {
      total = total.add(brl("0.01"));
    }
    expect(total.toJSON().amount).toBe("10.00");
  });

  test("subtracts into negative results with fixed scale", () => {
    expect(brl("0.01").subtract(brl("0.02")).toJSON().amount).toBe("-0.01");
    expect(brl("975.00").subtract(brl("1000.50")).toJSON().amount).toBe("-25.50");
  });

  test("keeps the largest accepted amount exact", () => {
    const largest = brl("99999999999999999.99");
    expect(largest.add(brl("0.01")).toJSON().amount).toBe("100000000000000000.00");
    expect(largest.subtract(largest).isZero()).toBe(true);
  });

  test("negates, and the negation of zero is plain zero", () => {
    expect(brl("25.00").negate().toJSON().amount).toBe("-25.00");
    expect(brl("25.00").negate().negate().equals(brl("25.00"))).toBe(true);
    expect(Money.zero("BRL").negate().toJSON().amount).toBe("0.00");
  });

  test("is immutable", () => {
    const original = brl("10.00");
    const sum = original.add(brl("5.00"));
    expect(original.toJSON().amount).toBe("10.00");
    expect(sum).not.toBe(original);
    expect(Object.isFrozen(original)).toBe(true);
  });
});

describe("Money comparisons", () => {
  test("reports sign", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.00").subtract(brl("0.01")).isNegative()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
  });

  test("orders amounts of the same currency", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
  });

  test("compares amount and currency for equality", () => {
    expect(brl("25.00").equals(brl("25.00"))).toBe(true);
    expect(brl("25.00").equals(brl("25.01"))).toBe(false);
    expect(brl("25.00").equals(Money.from({ amount: "25.00", currency: "USD" }))).toBe(false);
  });
});

describe("Money currency conflicts", () => {
  const usd = Money.from({ amount: "10.00", currency: "USD" });

  test.each([
    ["add", () => brl("10.00").add(usd)],
    ["subtract", () => brl("10.00").subtract(usd)],
    ["isLessThan", () => brl("10.00").isLessThan(usd)],
  ])("%s across currencies throws CurrencyMismatchError", (_, operation) => {
    expect(operation).toThrow(CurrencyMismatchError);
  });

  test("zero validates the currency", () => {
    expect(() => Money.zero("real")).toThrow(InvalidMoneyError);
  });
});

describe("Money serialization", () => {
  test("serializes as MoneyProps in JSON and as text in toString", () => {
    expect(JSON.stringify({ money: brl("25.00") })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(brl("25.00").toString()).toBe("25.00 BRL");
  });
});
