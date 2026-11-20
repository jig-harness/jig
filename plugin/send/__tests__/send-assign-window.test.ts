/**
 * `jig send pickup@… assign` on a tracker whose history leaves out changes
 * made just after an issue's creation (Linear, over a fake workspace): the
 * send writes the assignment only once that window has passed, and an item
 * already assigned to the factory identity whose history holds no
 * assignment of it is refused with the remedy, never reassigned.
 */
import { describe, expect, it } from "bun:test";
import {
  FACTORY,
  fakeClock,
  fakeLinear,
  iso,
  T0,
} from "../../skills/do-item/__tests__/linear-window-fake.ts";
import {
  LINEAR_CREATION_QUIET_MS,
  WINDOW_MARGIN_MS,
  waitBeforeAssigning,
} from "../../skills/do-item/scripts/lib/tracker/assignment-window.ts";
import type { Issue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  assignableFrom,
  unseenAssignment,
  writeAfterWindow,
} from "../lib/assign.ts";

const FROM = T0 + LINEAR_CREATION_QUIET_MS + WINDOW_MARGIN_MS;

describe("jig send assign on Linear", () => {
  it("waits until the creation window has passed before writing, and the write lands after it", async () => {
    const clock = fakeClock(T0 + 58_000);
    const linear = fakeLinear(clock);
    const from = await assignableFrom(linear.tracker, "ENG-1", 30);
    expect(from).toEqual({ ok: true, value: FROM });
    if (!from.ok) return;
    const unstarted = {
      state: { id: "s-todo", name: "Todo", type: "unstarted" },
    } as unknown as Issue;
    const tracker = {
      ...linear.tracker,
      getIssue: async () => unstarted,
      user: linear.tracker.user.bind(linear.tracker),
      assignees: linear.tracker.assignees.bind(linear.tracker),
      assign: linear.tracker.assign.bind(linear.tracker),
      transition: async () => {},
    };
    const wrote = await writeAfterWindow(
      tracker,
      {
        key: "ENG-1",
        identity: FACTORY,
        move: null,
        moveFor: () => null,
        from: from.value,
      },
      clock,
    );
    expect(wrote.ok).toBe(true);
    expect(clock.waits).toEqual([FROM - (T0 + 58_000)]);
    expect(linear.writes).toEqual([{ at: FROM, to: FACTORY }]);
    expect(waitBeforeAssigning(FROM, FROM + 1)).toEqual({
      waitMs: 0,
      until: null,
    });
    expect(waitBeforeAssigning(FROM, T0)).toMatchObject({ until: iso(FROM) });
  });

  it("refuses an item assigned to the identity with no assignment in its history, naming the remedy", async () => {
    const linear = fakeLinear(fakeClock(T0 + 10 * 60_000), {
      assignee: FACTORY,
    });
    const unseen = await unseenAssignment(linear.tracker, "ENG-1", FACTORY, 30);
    expect(unseen).toContain("its history holds no assignment of");
    expect(unseen).toContain(
      "unassign ENG-1 on the tracker, then send this again",
    );
    expect(linear.writes).toEqual([]);
  });

  it("finds nothing to refuse when the history shows the assignment", async () => {
    const linear = fakeLinear(fakeClock(T0 + 10 * 60_000), {
      assignee: FACTORY,
      history: [{ createdAt: iso(T0 + 5 * 60_000), toAssignee: FACTORY }],
    });
    expect(
      await unseenAssignment(linear.tracker, "ENG-1", FACTORY, 30),
    ).toBeNull();
  });
});
