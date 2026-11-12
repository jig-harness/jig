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
import { writeLabels } from "../lib/actions/labels.ts";
import type { editLabels } from "../lib/forge.ts";
import {
  failureCauses,
  homeOf,
  hostNoticeKeys,
} from "../lib/failure-notices.ts";
import {
  actionBook,
  backoffAfter,
  FAILURE_DEFAULTS,
  type FailureRow,
  quietFailure,
  readFailures,
  recordFailure,
} from "../lib/failures.ts";
import type { MachineRepository } from "../lib/machine-config.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";

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

describe("a quiet row and a copy that predates the quiet columns", () => {
  it("ends the quiet when an older copy's failure moves last_at without touching quiet_at, and counts it as one renewal that the next failure keeps", () => {
    const root = stateRootForTest();
    const tick = {
      repo: "",
      key: "ticks /c",
      kind: "tick" as const,
      target: "ticks of o/c",
    };
    recordFailure(
      tick,
      "a",
      Date.parse("2026-11-06T10:00:00.000Z"),
      SETTINGS,
      root,
    );
    quietFailure("", tick.key, "2026-11-06T10:05:00.000Z", root);
    expect(readFailures("", root)[0]?.quietAt).toBe("2026-11-06T10:05:00.000Z");
    // What an older copy's conflict update does: count and last_at only.
    stateDb(root)
      .query("UPDATE failures SET count = count + 1, last_at = ? WHERE key = ?")
      .run("2026-11-06T10:10:00.000Z", tick.key);
    const [after] = readFailures("", root);
    expect(after?.quietAt).toBeNull();
    expect(after?.renewals).toBe(1);
    const next = recordFailure(
      tick,
      "b",
      Date.parse("2026-11-06T10:15:00.000Z"),
      SETTINGS,
      root,
    );
    expect(next.renewals).toBe(1);
    expect(next.quietAt).toBeNull();
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

  it("says whether a row still stands, which a success or the planner dropping its key ends", () => {
    const root = stateRootForTest();
    const book = actionBook("o/r", SETTINGS, () => undefined, root);
    expect(book.standing(LABEL.key)).toBe(false);
    book.ran(LABEL, "refused");
    expect(book.standing(LABEL.key)).toBe(true);
    book.wanted("label", []);
    expect(book.standing(LABEL.key)).toBe(false);
  });

  it("keeps the rows of targets the tick did not observe when it drops the unwanted", () => {
    const root = stateRootForTest();
    const book = actionBook("o/r", SETTINGS, () => undefined, root);
    book.ran(LABEL, "refused");
    book.ran({ key: "label PR #8", kind: "label", target: "PR #8" }, "refused");
    book.wanted("label", [], (target) => target === "PR #7");
    expect(readFailures("o/r", root).map((r) => r.key)).toEqual([LABEL.key]);
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
    quietAt: null,
    renewals: 0,
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
    // The act phase finds the action unwanted by this key.
    expect(cause?.evidence.row).toBe("label PR #7");
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

  it("keys the host's own failures without the destination, so a home that moves tells nothing twice", () => {
    const machine = { repositories: [repository("/c"), repository("/d")] };
    const tick = row({
      repo: "",
      key: "ticks sweep",
      kind: "tick",
      target: "ticks of several repositories",
    });
    const failingC = row({
      repo: "/c",
      key: "repository",
      kind: "repository",
      target: "o/c",
    });
    const atD = failureCauses("o/d", "/d", [tick, failingC], machine);
    const atC = failureCauses("o/c", "/c", [tick], machine);
    expect(atC[0]?.notice?.key).toBe(
      "host ticks sweep failing since 2026-11-06T10:00:00.000Z",
    );
    expect(atD[0]?.notice?.key).toBe(atC[0]?.notice?.key);
  });

  it("tells nothing of a quiet wake-up row, and lets its notice retire", () => {
    const machine = { repositories: [repository("/c")] };
    const quiet = row({
      repo: "",
      key: "ticks /c",
      kind: "tick",
      target: "ticks of o/c",
      quietAt: "2026-11-06T10:30:00.000Z",
    });
    expect(failureCauses("o/c", "/c", [quiet], machine)).toEqual([]);
    expect(hostNoticeKeys([quiet]).size).toBe(0);
    const loud = { ...quiet, quietAt: null };
    expect(
      failureCauses("o/c", "/c", [loud], machine).map((c) => c.cause),
    ).toEqual(["ticks-failing"]);
    expect(hostNoticeKeys([loud]).size).toBe(1);
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

describe("a successful claim listing holding a trusted claim that does not read", () => {
  it("keeps the failure rows of its pull request, as a listing that failed does", async () => {
    const { settleOwnClaims } = await import("../lib/shared-launches.ts");
    const root = stateRootForTest();
    const book = actionBook("o/r", SETTINGS, () => undefined, root);
    const end = {
      key: "claim-end PR #9 comment 5",
      kind: "claim-end" as const,
      target: "PR #9",
    };
    book.ran(end, "the forge refused it");
    const bad = {
      id: 6,
      login: "drive-bot",
      trusted: true,
      says: { ok: false, failure: { reason: "damaged body" } },
    };
    const claims = new Map([[9, { ok: true, value: [bad] }]]);
    const ctx = {
      slug: "o/r",
      host: "h",
      owner: true,
      login: "drive-bot",
      root,
    };
    await settleOwnClaims(
      ctx as never,
      claims as never,
      [],
      [],
      new Map(),
      new Date().toISOString(),
      undefined,
      book,
    );
    expect(readFailures("o/r", root).map((r) => r.key)).toEqual([end.key]);
  });
});

describe("a pull request's state and marker label writes", () => {
  it("keep failure rows of their own, so one's backoff and success leave the other's alone", async () => {
    const root = stateRootForTest();
    const book = actionBook("o/r", SETTINGS, () => undefined, root);
    const changes = [
      { pr: 7, add: ["a"], remove: [] },
      { pr: 7, add: ["m"], remove: [], part: "markers" as const },
    ];
    const mode = { apply: true, late: () => null, book };
    const refuse = async (_s: string, _pr: number, add: string[]) =>
      add[0] === "m"
        ? ({ ok: false, failure: { reason: "label m is missing" } } as const)
        : ({ ok: true } as const);
    const edit = refuse as unknown as typeof editLabels;
    for (let i = 0; i < 2; i++) await writeLabels("o/r", changes, mode, edit);
    expect(readFailures("o/r", root).map((r) => r.key)).toEqual([
      "label markers PR #7",
    ]);
    const third = await writeLabels("o/r", changes, mode, edit);
    expect(third.map((w) => w.outcome)).toEqual(["written", "waits"]);
  });
});
