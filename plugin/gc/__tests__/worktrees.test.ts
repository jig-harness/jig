import { expect, test } from "bun:test";
import {
  classifyWorktree,
  type WorktreeEvidence,
} from "../kinds/worktree-evidence.ts";

const guard = 7 * 86_400_000;
function evidence(overrides: Partial<WorktreeEvidence> = {}): WorktreeEvidence {
  return {
    dirty: false,
    hiddenIndexChanges: false,
    operation: null,
    ignoredContent: false,
    requests: [{ state: "MERGED", head: "a".repeat(40) }],
    localOnlyCommits: false,
    mergedHeadCovers: true,
    aheadOfBase: 0,
    held: false,
    idleMs: guard + 1,
    ...overrides,
  };
}
test("a merged branch with an open pull request stays live", () => {
  expect(
    classifyWorktree(
      evidence({
        requests: [
          { state: "MERGED", head: "a".repeat(40) },
          { state: "OPEN", head: "b".repeat(40) },
        ],
      }),
      guard,
    ).state,
  ).toBe("live");
});
test("a squash-merged head covers commits absent from the base history", () => {
  expect(
    classifyWorktree(
      evidence({ localOnlyCommits: true, mergedHeadCovers: true }),
      guard,
    ),
  ).toMatchObject({ state: "dead", reportOnly: expect.any(String) });
});
test("a commit made after the recorded merged head vetoes retirement", () => {
  expect(
    classifyWorktree(
      evidence({ localOnlyCommits: true, mergedHeadCovers: false }),
      guard,
    ).state,
  ).toBe("live");
});
test("closed worktrees require every commit to be on a remote branch", () => {
  const requests = [{ state: "CLOSED" as const, head: "a".repeat(40) }];
  expect(
    classifyWorktree(evidence({ requests, localOnlyCommits: true }), guard)
      .state,
  ).toBe("live");
  expect(
    classifyWorktree(evidence({ requests, localOnlyCommits: false }), guard),
  ).toMatchObject({ state: "dead", reportOnly: expect.any(String) });
});
test("age does not replace registration of a worktree without a pull request", () => {
  expect(
    classifyWorktree(evidence({ requests: [], aheadOfBase: 0 }), guard).state,
  ).toBe("finding");
  expect(
    classifyWorktree(evidence({ requests: [], aheadOfBase: 1 }), guard).state,
  ).toBe("live");
});
test("dirty files, hidden index flags, operations and process holders independently veto", () => {
  for (const overrides of [
    { dirty: true },
    { hiddenIndexChanges: true },
    { operation: "merge" },
    { held: true },
    { idleMs: 0 },
  ])
    expect(classifyWorktree(evidence(overrides), guard).state).toBe("live");
});
test("unknown forge, process, ancestry and idle evidence fails closed", () => {
  for (const overrides of [
    { requests: null },
    { held: null },
    { localOnlyCommits: null },
    { idleMs: null },
    { localOnlyCommits: true, mergedHeadCovers: null },
  ])
    expect(classifyWorktree(evidence(overrides), guard).state).toBe(
      "unverified",
    );
});
test("ignored local content needs independent preservation evidence", () => {
  expect(
    classifyWorktree(evidence({ ignoredContent: true }), guard).state,
  ).toBe("finding");
});
test("a runtime's registry stands in for session admission, and only it", () => {
  const coordinated = classifyWorktree(evidence({ coordinated: true }), guard);
  expect(coordinated.state).toBe("dead");
  expect(coordinated.reportOnly).toBeUndefined();
  expect(coordinated.reason).toContain("registry shows no agent");
  for (const overrides of [{ held: true }, { idleMs: 0 }, { dirty: true }])
    expect(
      classifyWorktree(evidence({ ...overrides, coordinated: true }), guard)
        .state,
    ).toBe("live");
  expect(
    classifyWorktree(evidence({ requests: [], coordinated: true }), guard)
      .state,
  ).toBe("finding");
});
