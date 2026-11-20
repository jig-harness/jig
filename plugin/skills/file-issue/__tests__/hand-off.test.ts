/**
 * Handing a newly filed issue to the line. Over a fake Linear workspace
 * whose history, like Linear's, leaves out an assignment made in an issue's
 * first three minutes, the hand-off writes the assignment only after that
 * window, and the dispatcher's assigner read (`assignedBy`) then finds it.
 * A tracker with no window is assigned at once. An issue already assigned
 * is never changed.
 */
import { describe, expect, it } from "bun:test";
import { AssignerUnknown } from "../../do-item/scripts/lib/tracker/assigner-unknown.ts";
import {
  LINEAR_CREATION_QUIET_MS,
  WINDOW_MARGIN_MS,
} from "../../do-item/scripts/lib/tracker/assignment-window.ts";
import {
  FACTORY,
  fakeClock,
  fakeLinear,
  iso,
  T0,
} from "../../do-item/__tests__/linear-window-fake.ts";
import type {
  PoolIssue,
  TrackerUser,
} from "../../do-item/scripts/lib/tracker/port.ts";
import { parse as parseHandOffArgs } from "../scripts/hand-off.ts";
import { type HandOffTracker, handOff } from "../scripts/lib/hand-off.ts";

describe("handOff on Linear", () => {
  it("writes the assignment after the creation window, and the assigner read finds it", async () => {
    const clock = fakeClock(T0 + 58_000);
    const linear = fakeLinear(clock);
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: true,
      clock,
    });
    expect(result).toMatchObject({ handedOver: true, to: FACTORY });
    expect(linear.writes).toHaveLength(1);
    const written = linear.writes[0]?.at ?? 0;
    expect(written).toBeGreaterThanOrEqual(T0 + LINEAR_CREATION_QUIET_MS);
    expect(result.handedOver && result.confirmedAt).toBe(iso(written));
    expect(clock.waits).toEqual([
      LINEAR_CREATION_QUIET_MS + WINDOW_MARGIN_MS - 58_000,
    ]);
    // The dispatcher's assigner read: who made the assignment, from the history.
    const by = await linear.tracker.assignedBy("ENG-1", FACTORY);
    expect(by).toMatchObject({ id: "lead", trusted: true });
  });

  it("an assignment written inside the window is one the assigner read never finds", async () => {
    const clock = fakeClock(T0 + 58_000);
    const linear = fakeLinear(clock);
    const user: TrackerUser = await linear.tracker.user(FACTORY);
    await linear.tracker.assign("ENG-1", user);
    await expect(
      linear.tracker.assignedBy("ENG-1", FACTORY),
    ).rejects.toBeInstanceOf(AssignerUnknown);
  });

  it("ends a hand-off that outruns its own deadline without writing", async () => {
    const clock = fakeClock(T0 + 58_000);
    const linear = fakeLinear(clock);
    const slow: HandOffTracker = {
      ...linear.tracker,
      poolIssue: (_key, signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        ),
    };
    const result = await handOff(slow, "ENG-1", FACTORY, {
      wait: true,
      clock,
      deadlineMs: 20,
    });
    expect(result.handedOver).toBe(false);
    expect(linear.writes).toHaveLength(0);
  });

  it("aborts the operation signal its tracker was opened with when the deadline expires", async () => {
    const clock = fakeClock(T0 + 58_000);
    const linear = fakeLinear(clock);
    const operation = new AbortController();
    const slow: HandOffTracker = {
      ...linear.tracker,
      poolIssue: (_key, signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        ),
    };
    await handOff(slow, "ENG-1", FACTORY, {
      wait: true,
      clock,
      deadlineMs: 20,
      operation,
    });
    expect(operation.signal.aborted).toBe(true);
  });

  it("without waiting, names the time from which the hand-off may run and writes nothing", async () => {
    const clock = fakeClock(T0 + 58_000);
    const linear = fakeLinear(clock);
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: false,
      clock,
    });
    const earliest = iso(T0 + LINEAR_CREATION_QUIET_MS + WINDOW_MARGIN_MS);
    expect(result).toMatchObject({ handedOver: false, earliest });
    expect(!result.handedOver && result.remedy).toContain(earliest);
    expect(linear.writes).toEqual([]);
    expect(clock.waits).toEqual([]);
  });

  it("writes at once once the window has passed", async () => {
    const clock = fakeClock(T0 + 10 * 60_000);
    const linear = fakeLinear(clock);
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: false,
      clock,
    });
    expect(result.handedOver).toBe(true);
    expect(clock.waits).toEqual([]);
    expect(linear.writes).toEqual([
      { at: T0 + 10 * 60_000, from: null, to: FACTORY },
    ]);
  });

  it("leaves an assignment its history does not show as it is, and says how to repair it", async () => {
    const clock = fakeClock(T0 + 10 * 60_000);
    const linear = fakeLinear(clock, { assignee: FACTORY });
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: true,
      clock,
    });
    expect(result.handedOver).toBe(false);
    expect(!result.handedOver && result.reason).toContain(
      "its history holds no assignment of",
    );
    expect(!result.handedOver && result.remedy).toContain(
      "unassign ENG-1 on the tracker, then assign it to",
    );
    expect(linear.writes).toEqual([]);
  });

  it("writes nothing for an assignment its history shows", async () => {
    const clock = fakeClock(T0 + 10 * 60_000);
    const linear = fakeLinear(clock, {
      assignee: FACTORY,
      history: [{ createdAt: iso(T0 + 5 * 60_000), toAssignee: FACTORY }],
    });
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: true,
      clock,
    });
    expect(result).toMatchObject({ handedOver: true, confirmedAt: null });
    expect(linear.writes).toEqual([]);
  });

  it("writes nothing when someone assigns the issue while it waits", async () => {
    const clock = fakeClock(T0 + 58_000);
    const linear = fakeLinear(clock);
    const sleep = clock.sleep;
    clock.sleep = async (ms: number) => {
      await sleep(ms);
      linear.setAssignee("dana@example.com");
    };
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: true,
      clock,
    });
    expect(result.handedOver).toBe(false);
    expect(!result.handedOver && result.reason).toContain(
      "was assigned to dana@example.com while the hand-off waited",
    );
    expect(linear.writes).toEqual([]);
  });

  it("keeps an assignment made after the final read of the issue", async () => {
    const clock = fakeClock(T0 + 10 * 60_000);
    const linear = fakeLinear(clock);
    let reads = 0;
    // The hand-off's final read is its second; a person assigns just after it.
    linear.onPoolRead(() => {
      reads += 1;
      if (reads === 2) linear.setAssignee("dana@example.com");
    });
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: true,
      clock,
    });
    expect(result.handedOver).toBe(false);
    expect(!result.handedOver && result.reason).toContain("was not assigned");
    expect(linear.writes).toEqual([]);
    const held = await linear.tracker.poolIssue("ENG-1");
    expect(held?.assignee?.id).toBe("dana@example.com");
  });

  it("does not count an assignment by someone who may not start work as handed over", async () => {
    const clock = fakeClock(T0 + 10 * 60_000);
    const linear = fakeLinear(clock, {
      assignee: FACTORY,
      history: [
        {
          createdAt: iso(T0 + 5 * 60_000),
          toAssignee: FACTORY,
          byGuest: true,
        },
      ],
    });
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: true,
      clock,
    });
    expect(result.handedOver).toBe(false);
    expect(!result.handedOver && result.reason).toContain(
      "who may not start work",
    );
    expect(linear.writes).toEqual([]);
  });

  it("refuses to take an issue from someone else", async () => {
    const clock = fakeClock(T0 + 10 * 60_000);
    const linear = fakeLinear(clock, { assignee: "dana@example.com" });
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: true,
      clock,
    });
    expect(result.handedOver).toBe(false);
    expect(!result.handedOver && result.reason).toContain(
      "assigned to dana@example.com",
    );
    expect(linear.writes).toEqual([]);
  });

  it("reports a failed write as not handed over, with what to do", async () => {
    const clock = fakeClock(T0 + 10 * 60_000);
    const linear = fakeLinear(clock);
    linear.failAssign();
    const result = await handOff(linear.tracker, "ENG-1", FACTORY, {
      wait: true,
      clock,
    });
    expect(result.handedOver).toBe(false);
    expect(!result.handedOver && result.reason).toContain(
      "could not assign ENG-1",
    );
    expect(!result.handedOver && result.remedy).toContain(
      "run the hand-off again",
    );
  });
});

describe("handOff on a tracker whose history records every change", () => {
  it("assigns a just-filed issue without waiting", async () => {
    const clock = fakeClock(T0 + 1_000);
    const assigned: string[] = [];
    let assignee: TrackerUser | null = null;
    const pool: PoolIssue = {
      identifier: "#7",
      title: "filed",
      url: null,
      priority: 2,
      createdAt: iso(T0),
      state: { id: "todo", name: "Todo", type: "unstarted" },
      assignee: null,
      labels: [],
      hasOpenChildren: false,
      truncated: [],
      type: null,
      size: null,
    } as unknown as PoolIssue;
    const github: HandOffTracker = {
      adapter: "github",
      poolIssue: async () => pool,
      user: async (login) => ({ id: `U_${login}`, name: login }),
      assign: async (key, user) => {
        assigned.push(key);
        assignee = user;
      },
      assignees: async () => (assignee === null ? [] : [assignee]),
      assignedBy: async () => ({ id: "m", name: "maintainer", trusted: true }),
    };
    const result = await handOff(github, "#7", "factory-bot", {
      wait: true,
      clock,
    });
    expect(result).toMatchObject({
      handedOver: true,
      confirmedAt: iso(T0 + 1_000),
    });
    expect(assigned).toEqual(["#7"]);
    expect(clock.waits).toEqual([]);
  });
});

describe("hand-off command line", () => {
  it("reads the key, the identity and whether to wait", () => {
    expect(parseHandOffArgs(["ENG-1", "--to", " ada "])).toEqual({
      key: "ENG-1",
      to: "ada",
      wait: true,
    });
    expect(parseHandOffArgs(["--no-wait", "--to", "ada", "ENG-1"]).wait).toBe(
      false,
    );
  });
});
