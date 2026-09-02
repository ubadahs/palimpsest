import { describe, expect, it } from "vitest";

import { dedupeInFlight, pMap } from "../../src/shared/concurrency.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("pMap", () => {
  it("returns results in input order whatever the completion order", async () => {
    const delays = [30, 5, 20, 1];
    const result = await pMap(
      delays,
      async (delay, index) => {
        await tick(delay);
        return index;
      },
      { concurrency: 4 },
    );
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it("never runs more items at once than the concurrency allows", async () => {
    let inFlight = 0;
    let peak = 0;
    await pMap(
      Array.from({ length: 10 }, (_, index) => index),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick(2);
        inFlight -= 1;
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
  });

  it("stops dispatching after the first failure and rethrows it", async () => {
    const started: number[] = [];
    await expect(
      pMap(
        Array.from({ length: 10 }, (_, index) => index),
        async (index) => {
          started.push(index);
          await tick(1);
          if (index === 1) throw new Error("fatal at 1");
        },
        { concurrency: 2 },
      ),
    ).rejects.toThrow("fatal at 1");
    // The two workers each took one item; at most one more item could start
    // before the failure was observed.
    expect(started.length).toBeLessThanOrEqual(3);
  });
});

describe("dedupeInFlight", () => {
  it("shares one pending call across identical keys, then forgets it", async () => {
    const inFlight = new Map<string, Promise<number>>();
    let calls = 0;
    const start = async () => {
      calls += 1;
      await tick(5);
      return calls;
    };

    const [first, second] = await Promise.all([
      dedupeInFlight(inFlight, "k", start),
      dedupeInFlight(inFlight, "k", start),
    ]);
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(inFlight.size).toBe(0);

    // Once settled, a new request goes through again (the persistent cache
    // is the layer that would answer it).
    expect(await dedupeInFlight(inFlight, "k", start)).toBe(2);
  });
});
