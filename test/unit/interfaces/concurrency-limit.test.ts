import { describe, expect, test } from "bun:test";
import { ConcurrencyLimit } from "../../../src/interfaces/sqs/concurrency-limit";

describe("ConcurrencyLimit", () => {
  test("never runs more tasks at once than the limit and runs them all", async () => {
    const limit = new ConcurrencyLimit(3);
    let running = 0;
    let peak = 0;
    const started: number[] = [];

    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        limit.run(async () => {
          started.push(index);
          running += 1;
          peak = Math.max(peak, running);
          await Bun.sleep(index % 3);
          running -= 1;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(started.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, index) => index));
  });

  test("frees the slot when a task fails", async () => {
    const limit = new ConcurrencyLimit(1);

    await expect(limit.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

    expect(await limit.run(async () => "next")).toBe("next");
  });
});
