import { describe, expect, it } from "bun:test";
import { recordedBudget } from "../lib/tick-reads.ts";

const window = (
  remaining: number | null,
  resetAt: number,
  answeredAt: number | null = 10_000_000 - 30_000,
) => ({
  limit: 5000,
  remaining,
  resetAt,
  answeredAt,
});

describe("the tick's forge budget from the machine's record", () => {
  const now = 10_000_000;

  it("reads the core balance an answer recorded within the last minute", () => {
    expect(
      recordedBudget(now, {
        core: window(2600.4, now + 600_000),
        graphql: window(4000, now + 600_000),
        observedAt: now - 30_000,
      }),
    ).toEqual({
      remaining: 2600,
      limit: 5000,
      resetAt: new Date(now + 600_000).toISOString(),
    });
  });

  it("reads a window whose reset has passed as full", () => {
    expect(
      recordedBudget(now, {
        core: window(0, now - 1),
        graphql: window(4000, now + 600_000),
        observedAt: now - 30_000,
      })?.remaining,
    ).toBe(5000);
  });

  it("asks the forge when the record is older than a minute, holds no core balance, or is missing", () => {
    const fresh = {
      graphql: window(4000, now + 600_000),
      observedAt: now - 30_000,
    };
    expect(
      recordedBudget(now, {
        ...fresh,
        core: window(2600, now + 600_000, now - 61_000),
        observedAt: now - 61_000,
      }),
    ).toBeNull();
    // Another window's answer keeps the record fresh, not the core balance.
    expect(
      recordedBudget(now, {
        ...fresh,
        core: window(2600, now + 600_000, now - 61_000),
        observedAt: now - 1_000,
      }),
    ).toBeNull();
    expect(
      recordedBudget(now, { ...fresh, core: window(null, now + 600_000) }),
    ).toBeNull();
    expect(recordedBudget(now, null)).toBeNull();
  });
});
