import { describe, expect, test } from "bun:test";
import { DeadlockException, LockWaitTimeoutException } from "@mikro-orm/core";
import { isTransientDatabaseError, lockConflictOf } from "../../../src/infrastructure/database/transient-error";

const pgError = (code: string) => Object.assign(new Error(code), { code });

describe("lockConflictOf", () => {
  test("a lock timeout is a timeout conflict, as raised by Postgres or converted by MikroORM", () => {
    expect(lockConflictOf(pgError("55P03"))).toBe("timeout");
    expect(lockConflictOf(new LockWaitTimeoutException(pgError("55P03")))).toBe("timeout");
  });

  test("a deadlock is a deadlock conflict, as raised by Postgres or converted by MikroORM", () => {
    expect(lockConflictOf(pgError("40P01"))).toBe("deadlock");
    expect(lockConflictOf(new DeadlockException(pgError("40P01")))).toBe("deadlock");
  });

  test.each(["23505", "40001", "57P01", "ECONNREFUSED"])("%s is not a lock conflict", (code) => {
    expect(lockConflictOf(pgError(code))).toBeUndefined();
  });

  test("anything without a code is not a lock conflict", () => {
    expect(lockConflictOf(new Error("boom"))).toBeUndefined();
    expect(lockConflictOf(undefined)).toBeUndefined();
  });

  test("every lock conflict is also transient", () => {
    expect(isTransientDatabaseError(pgError("55P03"))).toBe(true);
    expect(isTransientDatabaseError(pgError("40P01"))).toBe(true);
  });
});
