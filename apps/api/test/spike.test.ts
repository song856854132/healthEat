import { describe, expect, it } from "vitest";
import { waitAtLeast } from "../src/routes/spike.js";

// #43: a timer can wake a fraction of a millisecond before its delay by another clock,
// and the 65 s e2e check then read waitedMs 64999.
describe("waitAtLeast", () => {
  it("never reports less than the requested time, even when the timer wakes early", async () => {
    const reads = [1000, 65_999.4, 66_000.2]; // start, early wake (64999.4 ms), after the top-up
    const sleeps: number[] = [];
    const waited = await waitAtLeast(
      65_000,
      () => reads.shift() ?? Number.NaN,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(sleeps).toEqual([65_000, 1]);
    expect(waited).toBe(65_001);
  });

  it("rounds a fractional wait up, never down", async () => {
    const reads = [0, 200.3];
    const waited = await waitAtLeast(
      200,
      () => reads.shift() ?? Number.NaN,
      async () => {},
    );
    expect(waited).toBe(201);
  });

  it("waits for real with the default clock and timer", async () => {
    expect(await waitAtLeast(30)).toBeGreaterThanOrEqual(30);
  });
});
