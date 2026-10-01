import { DomainError } from "./domain-error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export type InvalidMoneyReason =
  | "INVALID_FORMAT"
  | "INVALID_SCALE"
  | "NEGATIVE_AMOUNT"
  | "OUT_OF_RANGE"
  | "INVALID_CURRENCY";

export class InvalidMoneyError extends DomainError {
  constructor(
    readonly reason: InvalidMoneyReason,
    message: string,
  ) {
    super("INVALID_MONEY", message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super("CURRENCY_MISMATCH", `Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

const maxIntegerDigits = 17;
const centsPerUnit = 100n;
const amountPattern = /^(0|[1-9]\d{0,16})\.(\d{2})$/;
const nonNegativeDecimalPattern = /^(0|[1-9]\d*)(\.\d+)?$/;
const negativeDecimalPattern = /^-(0|[1-9]\d*)(\.\d+)?$/;
const currencyPattern = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props.currency);
    const amount: unknown = props.amount;
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("INVALID_FORMAT", "Amount must be a decimal string");
    }
    const match = amountPattern.exec(amount);
    if (!match) {
      throw Money.invalidAmount(amount);
    }
    const [, units, fraction] = match;
    return new Money(BigInt(`${units}${fraction}`), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const sign = this.cents < 0n ? "-" : "";
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const units = absolute / centsPerUnit;
    const fraction = (absolute % centsPerUnit).toString().padStart(2, "0");
    return `${sign}${units}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !currencyPattern.test(currency)) {
      throw new InvalidMoneyError("INVALID_CURRENCY", "Currency must be an ISO-4217 code such as BRL");
    }
    return currency;
  }

  private static invalidAmount(amount: string): InvalidMoneyError {
    if (negativeDecimalPattern.test(amount)) {
      return new InvalidMoneyError("NEGATIVE_AMOUNT", "Amount must not be negative");
    }
    const decimal = nonNegativeDecimalPattern.exec(amount);
    if (!decimal) {
      return new InvalidMoneyError("INVALID_FORMAT", "Amount must be a plain decimal string such as 25.00");
    }
    if ((decimal[1] ?? "").length > maxIntegerDigits) {
      return new InvalidMoneyError("OUT_OF_RANGE", `Amount must have at most ${maxIntegerDigits} integer digits`);
    }
    return new InvalidMoneyError("INVALID_SCALE", "Amount must have exactly 2 decimal places");
  }
}
