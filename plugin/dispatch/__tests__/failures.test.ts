/**
 * The failure ledger's rows on their own: an action's wait doubles with each
 * failure in a row up to its cap, a success or the action leaving the plan
 * removes its row, the notifications are planned only past the threshold,
 * and the host's own failures go to one repository, the first it owns with
 * `notify` whose turn is not failing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureCauses, homeOf } from "../lib/failure-notices.ts";
import {
  actionBook,
  backoffAfter,
  FAILURE_DEFAULTS,
  type FailureRow,
  readFailures,
  recordFailure,
} from "../lib/failures.ts";
import type { MachineRepository } from "../lib/machine-config.ts";
import { closeStateDb } from "../lib/state.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function stateRootForTest(): string {
  const root = mkdtempSync(join(tmpdir(), "dispatch-failures-"));
  roots.push(root);
  return root;
}

const SETTINGS = FAILURE_DEFAULTS;
const LABEL = { key: "label PR #7", kind: "label" as const, target: "PR #7" };

describe("the failure ledger's wait", () => {
  it("tries a first failure again at once, then waits from two minutes, doubling with each failure in a row and stopping at the hour", () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 30].map(
      (n) => backoffAfter(n, SETTINGS) / 60_000,
    );
    expect(minutes).toEqual([0, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it("counts failures in a row, keeps the first failure's time, and backs the action off until its next try", () => {
    const root = stateRootForTest();
    const first = recordFailure(
      { repo: "o/r", ...LABEL },
      "the forge refused it (HTTP 403)\nat stack line",
      1_000_000,
      SETTINGS,
      root,
    );
    expect(first).toMatchObject({
      count: 1,
      reason: "the forge refused it (HTTP 403)",
      nextAtMs: 1_000_000,
    });
    const second = recordFailure(
      { repo: "o/r", ...LABEL },
      "refused again",
      2_000_000,
      SETTINGS,
      root,
    );
    expect(second).toMatchObject({
      count: 2,
      firstAt: first.firstAt,
      reason: "refused again",
      nextAtMs: 2_000_000 + 2 * 60_000,
    });
  });

  it("never backs off a repository's turn or the tick: their rows only count", () => {
    const root = stateRootForTest();
    const row = recordFailure(
      { repo: "/r", key: "repository", kind: "repository", target: "o/r" },
      "the forge record did not read",
      5_000,
      SETTINGS,
      root,
    );
    expect(row.nextAtMs).toBe(5_000);
  });
});

describe("a repository's book of its actions", () => {
  it("says an action backs off with its count and next try, and a success removes its row", () => {
    const root = stateRootForTest();
    const failed: string[] = [];
    const book = actionBook("o/r", SETTINGS, (r) => failed.push(r), root);
    expect(book.waits(LABEL.key)).toBeNull();
    book.ran(LABEL, "the forge refused it");
    expect(book.waits(LABEL.key)).toBeNull();
    book.ran(LABEL, "the forge refused it");
    expect(book.waits(LABEL.key)).toMatch(
      /^backing off after 2 failures in a row since .* \(the last: the forge refused it\); next try at /,
    );
    book.ran(LABEL, null);
    expect(book.waits(LABEL.key)).toBeNull();
    expect(readFailures("o/r", root)).toEqual([]);
    expect(failed).toEqual([]);
  });

  it("drops the rows of a kind whose planner no longer wants their key, and leaves the other kinds", () => {
    const root = stateRootForTest();
    const failed: string[] = [];
    const book = actionBook("o/r", SETTINGS, (r) => failed.push(r), root);
    book.ran(LABEL, "refused");
    book.ran({ key: "label PR #8", kind: "label", target: "PR #8" }, "refused");
    book.ran(
      { key: "nudge rec ep", kind: "nudge", target: "ENG-1" },
      "no terminal",
    );
    book.wanted("label", ["label PR #8"]);
    expect(readFailures("o/r", root).map((r) => r.key)).toEqual([
      "label PR #8",
      "nudge rec ep",
    ]);
    expect(book.waits(LABEL.key)).toBeNull();
    expect(failed).toEqual([]);
  });
});

function row(
  fields: Partial<FailureRow> & Pick<FailureRow, "key">,
): FailureRow {
  return {
    repo: "o/r",
    kind: "label",
    target: "PR #7",
    count: 3,
    firstAt: "2026-11-06T10:00:00.000Z",
    lastAt: "2026-11-06T10:20:00.000Z",
    reason: "the forge refused it",
    nextAtMs: Date.parse("2026-11-06T10:36:00.000Z"),
    ...fields,
  };
}

const repository = (
  path: string,
  fields: Partial<MachineRepository> = {},
): MachineRepository => ({
  path,
  stages: ["rearm", "notify"],
  followupSince: null,
  owner: true,
  ...fields,
});

describe("the failure ledger's notifications", () => {
  it("plans one past the threshold, naming what failed, how often, since when and the last reason, and none below it or for a failure's own notice", () => {
    const machine = { repositories: [repository("/a")] };
    const causes = failureCauses(
      "o/r",
      "/elsewhere",
      [
        row({ key: "label PR #7" }),
        row({ key: "label PR #8", target: "PR #8", count: 2 }),
        row({ key: "notice x", kind: "failure-notice", count: 9 }),
      ],
      machine,
    );
    expect(causes).toHaveLength(1);
    const [cause] = causes;
    expect(cause).toMatchObject({
      stage: "notify",
      target: "PR #7",
      cause: "action-failing",
    });
    expect(cause?.notice?.key).toBe(
      "o/r label PR #7 failing since 2026-11-06T10:00:00.000Z",
    );
    expect(cause?.notice?.text).toContain(
      "Writing the dispatch labels of PR #7 has failed 3 times in a row since 2026-11-06T10:00:00.000Z. The last failure: the forge refused it.",
    );
    expect(cause?.notice?.text).toContain(
      "the next at 2026-11-06T10:36:00.000Z",
    );
  });

  it("sends the host's own failures to its first owned repository with notify whose turn is not failing", () => {
    const machine = {
      repositories: [
        repository("/a", { owner: false }),
        repository("/b", { stages: ["rearm"] }),
        repository("/c"),
        repository("/d"),
      ],
    };
    const tick = row({
      repo: "",
      key: "ticks sweep",
      kind: "tick",
      target: "ticks of several repositories",
    });
    expect(homeOf(machine, [])).toBe("/c");
    const failingC = row({
      repo: "/c",
      key: "repository",
      kind: "repository",
      target: "o/c",
    });
    expect(homeOf(machine, [failingC])).toBe("/d");
    const atD = failureCauses("o/d", "/d", [tick, failingC], machine);
    expect(atD.map((c) => c.cause)).toEqual([
      "ticks-failing",
      "repository-failing",
    ]);
    expect(atD[1]?.notice?.text).toContain(
      "The dispatcher's turn for o/c has failed 3 ticks in a row since",
    );
    expect(failureCauses("o/c", "/c", [tick, failingC], machine)).toEqual([]);
  });

  it("never notifies a repository's failures from a host that does not own it", () => {
    const machine = {
      repositories: [repository("/a"), repository("/b", { owner: false })],
    };
    const failingB = row({
      repo: "/b",
      key: "repository",
      kind: "repository",
      target: "o/b",
    });
    expect(failureCauses("o/a", "/a", [failingB], machine)).toEqual([]);
  });
});
