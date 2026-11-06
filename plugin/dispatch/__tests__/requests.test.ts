/**
 * `assignPickup`: the move first, the assignees read again before the
 * assignment replaces them and after it, and every failure returned as a
 * value.
 */
import { describe, expect, it } from "bun:test";
import type {
  Issue,
  TrackerUser,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { type AssignTracker, assignPickup } from "../lib/requests.ts";

const BOT: TrackerUser = { id: "U_bot", name: "factory-bot" };
const DANA: TrackerUser = { id: "U_dana", name: "dana" };

/** A tracker holding one item; `holders` is who holds it when read, and `calls` logs the writes. */
function tracker(opts: {
  holders?: TrackerUser[];
  failMove?: boolean;
  keepsHolders?: boolean;
  startedState?: boolean;
}) {
  const calls: string[] = [];
  let holders = opts.holders ?? [];
  const t: AssignTracker = {
    user: async () => BOT,
    assignees: async () => holders,
    assign: async (_key, user) => {
      calls.push("assign");
      if (opts.keepsHolders !== true) holders = [user];
    },
    getIssue: async () =>
      ({
        state: {
          name: "In Progress",
          type: opts.startedState ? "started" : "unstarted",
        },
      }) as Issue,
    transition: async () => {
      calls.push("transition");
      if (opts.failMove) throw new Error("the tracker is down");
    },
  };
  return { t, calls };
}

describe("assignPickup", () => {
  it("moves the item before it assigns it, and verifies the assignment", async () => {
    const { t, calls } = tracker({});
    expect((await assignPickup(t, "#14", "factory-bot", "todo")).ok).toBe(true);
    expect(calls).toEqual(["transition", "assign"]);
  });

  it("assigns nothing when the move fails, so sending it again finishes the request", async () => {
    const { t, calls } = tracker({ failMove: true });
    const r = await assignPickup(t, "#14", "factory-bot", "todo");
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["transition"]);
  });

  it("refuses an item someone took after the plan, without replacing them", async () => {
    const { t, calls } = tracker({ holders: [DANA] });
    const r = await assignPickup(t, "#14", "factory-bot", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toContain("now assigned to dana");
    expect(calls).toEqual([]);
  });

  it("refuses an item someone took after the plan before it moves it", async () => {
    const { t, calls } = tracker({ holders: [DANA] });
    const r = await assignPickup(t, "#14", "factory-bot", "todo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).not.toContain("already moved");
    expect(calls).toEqual([]);
  });

  it("refuses an item someone started after the plan, without moving it back", async () => {
    const { t, calls } = tracker({ startedState: true });
    const r = await assignPickup(t, "#14", "factory-bot", "todo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toContain("work in progress");
    expect(calls).toEqual([]);
  });

  it("refuses an assignment the tracker does not show afterwards", async () => {
    const { t } = tracker({ keepsHolders: true });
    const r = await assignPickup(t, "#14", "factory-bot", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toContain("after the assignment");
  });
});
