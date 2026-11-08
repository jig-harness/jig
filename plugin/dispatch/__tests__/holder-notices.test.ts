/**
 * holder-notices.ts: a launch a busy holder refused is one notification per
 * holder, and its suppression record stands through a tick whose launch of
 * the same target waited before it reached the open.
 */
import { describe, expect, test } from "bun:test";
import { holderActions, holderRecordStands } from "../lib/holder-notices.ts";
import type { LaunchOutcome } from "../lib/types.ts";

const SLUG = "example-org/web";
const holder = {
  path: "/work/agent-tree",
  branch: "feature/7",
  reasons: [
    "it has uncommitted or untracked changes",
    "process 42 has its working directory in it",
  ],
};
const refusedLaunch: LaunchOutcome = {
  target: "PR #7",
  action: "rearm",
  outcome: "refused",
  account: "a",
  record: null,
  detail: "waits on a person",
  holder,
};

describe("holderActions", () => {
  test("names the holder, the branch and what keeps it busy, once per key", () => {
    const actions = holderActions(SLUG, [refusedLaunch, refusedLaunch]);
    expect(actions).toHaveLength(1);
    const [action] = actions;
    expect(action).toMatchObject({
      stage: "notify",
      target: "PR #7",
      cause: "needs-person",
      evidence: { stage: "rearm", holder: holder.path, branch: holder.branch },
    });
    expect(action?.notice?.key).toBe(
      `${SLUG} PR #7 branch held by busy checkout feature/7 at /work/agent-tree`,
    );
    expect(action?.notice?.text).toContain(
      "is in use: it has uncommitted or untracked changes; process 42 has its working directory in it.",
    );
    expect(action?.notice?.text).toContain(`https://github.com/${SLUG}/pull/7`);
  });

  test("quotes the checkout's path in the commands it tells a person to run", () => {
    const odd = "/work/my tree; $(touch x)";
    const [action] = holderActions(SLUG, [
      { ...refusedLaunch, holder: { ...holder, path: odd } },
    ]);
    const text = action?.notice?.text ?? "";
    expect(text).toContain(
      "git -C '/work/my tree; $(touch x)' switch --detach",
    );
    expect(text).toContain("git worktree remove '/work/my tree; $(touch x)'");
  });

  test("ignores a launch no holder refused", () => {
    const { holder: _, ...plain } = refusedLaunch;
    expect(holderActions(SLUG, [plain])).toEqual([]);
  });
});

describe("holderRecordStands", () => {
  const key = `${SLUG} PR #7 branch held by busy checkout feature/7 at /work/agent-tree`;
  const { holder: _, ...plain } = refusedLaunch;
  const waiting: LaunchOutcome = { ...plain, outcome: "waits" };

  test("stands while its target's launch waited before the open", () => {
    expect(
      holderRecordStands({ launches: [waiting] }, { key, target: "PR #7" }),
    ).toBe(true);
  });

  test("stands while its target's launch was refused without seeing a holder", () => {
    const refusedPlain: LaunchOutcome = { ...plain, outcome: "refused" };
    expect(
      holderRecordStands(
        { launches: [refusedPlain] },
        { key, target: "PR #7" },
      ),
    ).toBe(true);
  });

  test("is dropped once the launch got past the open, or the target has no launch", () => {
    const launched: LaunchOutcome = { ...waiting, outcome: "launched" };
    expect(
      holderRecordStands({ launches: [launched] }, { key, target: "PR #7" }),
    ).toBe(false);
    expect(holderRecordStands({ launches: [] }, { key, target: "PR #7" })).toBe(
      false,
    );
  });

  test("never keeps another cause's record", () => {
    expect(
      holderRecordStands(
        { launches: [waiting] },
        {
          key: `${SLUG} PR #7 parked, ledger generation 3: finding F1`,
          target: "PR #7",
        },
      ),
    ).toBe(false);
  });
});
