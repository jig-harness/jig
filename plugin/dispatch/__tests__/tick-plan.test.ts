import { describe, expect, it } from "bun:test";
import type { TickContext } from "../lib/tick-context.ts";
import { afterWait } from "../lib/tick-plan.ts";
import type { Contention } from "../lib/contention.ts";

const serialized = {
  grouped: new Set([4, 5]),
  held: new Map(),
  unplaced: new Map([[5, "already unplaced"]]),
} as unknown as Contention;

describe("a serialized group after a wait for the act lock", () => {
  it("leaves the groups alone when the act lock was free", () => {
    const context = {} as TickContext;
    expect(afterWait(context, serialized)).toBe(serialized);
  });

  it("places no member of a group, keeping an existing reason", () => {
    const context = { actWaited: true } as TickContext;
    const { unplaced } = afterWait(context, serialized);
    expect(unplaced.get(4)).toContain("another tick acted");
    expect(unplaced.get(5)).toBe("already unplaced");
    expect(serialized.unplaced.has(4)).toBe(false);
  });
});
