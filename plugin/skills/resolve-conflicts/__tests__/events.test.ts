/**
 * The live record: events.ts and the cause in the `Conflicts resolved:`
 * section, against real scratch repositories for each kind of operation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { type CAUSES, primaryCause } from "../scripts/lib/causes.ts";
import {
  concludedCommit,
  type MergeConflictEvent,
} from "../scripts/lib/events.ts";
import type { Snapshot } from "../scripts/lib/snapshot.ts";
import { type Run, Scratch } from "./scratch.ts";

let s: Scratch;
const ok = (r: Run, code = 0) =>
  expectSpawnExit({ ...r, exitCode: r.code }, code);
beforeEach(() => {
  s = new Scratch("resolve-conflicts-events-");
});
afterEach(() => s.cleanup());

const LIST = "# List\n- a\n- c\n";
const withItem = (item: string) => `# List\n- a\n- ${item}\n- c\n`;

/** Map, resolve with `content`, record and stage `path`; the check passes. */
function resolve(
  path: string,
  content: string,
  reason = "kept both items",
  decision = "combined",
) {
  ok(s.script("conflict-map.ts"));
  s.write(path, content);
  s.git("add", path);
  ok(s.script("record.ts", [path, decision, "--reason", reason]));
  ok(s.script("check-resolution.ts"));
}

function eventsFile(): string {
  const common = s
    .git("rev-parse", "--path-format=absolute", "--git-common-dir")
    .trim();
  return `${common}/jig/conflict-events.jsonl`;
}

function events(): MergeConflictEvent[] {
  const path = eventsFile();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as MergeConflictEvent);
}

/** `main` and `feature` each insert an item at the same place of list.md. */
function sameInsertion(): void {
  s.commit("Add the list", { "list.md": LIST });
  s.git("checkout", "-q", "-b", "feature");
  s.commit("Add b1", { "list.md": withItem("b1") });
  s.git("checkout", "-q", "main");
  s.commit("Add b2 (#7)", { "list.md": withItem("b2") });
  s.git("checkout", "-q", "feature");
}

const BOTH = "# List\n- a\n- b1\n- b2\n- c\n";

describe("a merge", () => {
  beforeEach(() => {
    sameInsertion();
    expect(s.gitTry("merge", "main").code).not.toBe(0);
  });

  it("leaves one event per path, with the cause, once", () => {
    resolve("list.md", BOTH);
    const message = s.script("check-resolution.ts", ["--commit-message"]);
    ok(message);
    expect(message.stdout).toContain(
      "- list.md: combined [cause: append] — kept both items",
    );
    s.write(".msg", message.stdout);
    s.git("commit", "-q", "-F", ".msg");
    const head = s.git("rev-parse", "HEAD").trim();

    const first = s.script("events.ts");
    ok(first);
    expect(first.stdout).toContain("recorded 1 merge_conflict event");
    expect(events()).toMatchObject([
      {
        type: "merge_conflict",
        operation: "merge",
        path: "list.md",
        cause: "append",
        causes: ["append"],
        regions: 1,
        decision: "combined",
        reason: "kept both items",
        source: "session",
        commit: head,
        pr: null,
        branch: "feature",
        theirs_ref: "main",
      },
    ]);
    const [event] = events() as [MergeConflictEvent];
    expect(Date.parse(event.ts)).not.toBeNaN();
    expect(event.resolution_ms).toBeGreaterThanOrEqual(0);

    const again = s.script("events.ts");
    ok(again);
    expect(again.stdout).toContain("1 already recorded");
    expect(events()).toHaveLength(1);
  });

  it("marks a resolution a drive's conflict-resolve round started", () => {
    s.env.DRIVE_PR_ROUND_TASK = "conflict-resolve";
    s.env.DRIVE_PR_TARGET = "42";
    resolve("list.md", BOTH);
    s.git("commit", "-q", "--no-edit");
    ok(s.script("events.ts"));
    expect(events()).toMatchObject([{ source: "drive-pr", pr: 42 }]);
  });

  it("keeps the attribution the operation was mapped under, not the one it is recorded under", () => {
    s.env.DRIVE_PR_ROUND_TASK = "conflict-resolve";
    s.env.DRIVE_PR_TARGET = "42";
    resolve("list.md", BOTH);
    s.git("commit", "-q", "--no-edit");
    delete s.env.DRIVE_PR_ROUND_TASK;
    delete s.env.DRIVE_PR_TARGET;
    ok(s.script("events.ts"));
    expect(events()).toMatchObject([{ source: "drive-pr", pr: 42 }]);
  });

  it("appends after a line an interrupted write left unterminated", () => {
    resolve("list.md", BOTH);
    s.git("commit", "-q", "--no-edit");
    ok(s.script("events.ts", ["--json"]));
    const file = eventsFile();
    rmSync(file);
    appendFileSync(file, '{"type":"merge_con');
    ok(s.script("events.ts"));
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines[0]).toBe('{"type":"merge_con');
    expect(JSON.parse(lines[1] as string)).toMatchObject({ path: "list.md" });
  });

  it("takes no pull request from a pass that is not a conflict round", () => {
    resolve("list.md", BOTH);
    s.git("commit", "-q", "--no-edit");
    s.env.DRIVE_PR_ROUND_TASK = "ci-repair";
    s.env.DRIVE_PR_TARGET = "42";
    ok(s.script("events.ts"));
    expect(events()).toMatchObject([{ source: "session", pr: null }]);
  });

  it("refuses to record while the merge is still stopped", () => {
    resolve("list.md", BOTH);
    const r = s.script("events.ts");
    ok(r, 3);
    expect(r.stderr).toContain("still in progress");
    expect(events()).toEqual([]);
  });

  it("records nothing for a merge that was aborted, nor for the next ordinary commit", () => {
    ok(s.script("conflict-map.ts"));
    s.git("merge", "--abort");
    s.commit("Work on something else", { "other.md": "x\n" });
    const r = s.script("events.ts");
    ok(r);
    expect(r.stdout).toContain("did not conclude");
    expect(events()).toEqual([]);
  });

  it("counts a concluding commit that was amended afterwards once", () => {
    resolve("list.md", BOTH);
    s.git("commit", "-q", "--no-edit");
    ok(s.script("events.ts"));
    s.git("commit", "-q", "--amend", "-m", "Merge main, reworded");
    const again = s.script("events.ts");
    ok(again);
    expect(again.stdout).toContain("1 already recorded");
    expect(events()).toHaveLength(1);
  });

  it("names the branch the merge ran on, not the one checked out when it is recorded", () => {
    resolve("list.md", BOTH);
    s.git("commit", "-q", "--no-edit");
    s.git("checkout", "-q", "-b", "elsewhere");
    ok(s.script("events.ts"));
    expect(events()).toMatchObject([{ branch: "feature" }]);
  });

  it("refuses to write through a symbolic link, even a dangling one", () => {
    resolve("list.md", BOTH);
    s.git("commit", "-q", "--no-edit");
    const common = s
      .git("rev-parse", "--path-format=absolute", "--git-common-dir")
      .trim();
    symlinkSync(`${s.home}/nowhere`, `${common}/jig/conflict-events.jsonl`);
    const r = s.script("events.ts");
    ok(r, 1);
    expect(r.stderr).toContain("symbolic link");
    expect(existsSync(`${s.home}/nowhere`)).toBe(false);
    rmSync(`${common}/jig/conflict-events.jsonl`);
  });

  it("writes its record where every worktree of the clone finds it", () => {
    resolve("list.md", BOTH);
    s.git("commit", "-q", "--no-edit");
    ok(s.script("events.ts"));
    const common = s
      .git("rev-parse", "--path-format=absolute", "--git-common-dir")
      .trim();
    expect(existsSync(`${common}/jig/conflict-events.jsonl`)).toBe(true);
  });
});

describe("with nothing to record", () => {
  it("is quiet when no conflict was ever mapped", () => {
    s.commit("Add the list", { "list.md": LIST });
    const r = s.script("events.ts");
    ok(r);
    expect(r.stdout).toContain("nothing to record");
    expect(events()).toEqual([]);
  });

  it("rejects an argument it does not know", () => {
    ok(s.script("events.ts", ["--all"]), 2);
  });
});

/** Two files, each with a same-place insertion on both sides, in two feature commits. */
function twoStops(): void {
  s.commit("Add the lists", { "one.md": LIST, "two.md": LIST });
  s.git("checkout", "-q", "-b", "feature");
  s.commit("Add b1 to one", { "one.md": withItem("b1") });
  s.commit("Add b1 to two", { "two.md": withItem("b1") });
  s.git("checkout", "-q", "main");
  s.commit("Add b2 to both", {
    "one.md": withItem("b2"),
    "two.md": withItem("b2"),
  });
  s.git("checkout", "-q", "feature");
}

describe("a rebase", () => {
  it("records every stop, the earlier ones when the next map would overwrite their snapshot", () => {
    twoStops();
    expect(s.gitTry("rebase", "main").code).not.toBe(0);
    resolve("one.md", BOTH);
    // Continuing stops again, on the second commit.
    expect(s.gitTry("rebase", "--continue").code).not.toBe(0);
    // The second stop: mapping it records the first stop's events first.
    const map = s.script("conflict-map.ts");
    ok(map);
    expect(map.stderr).toContain("recorded 1 merge_conflict event");
    expect(events().map((e) => e.path)).toEqual(["one.md"]);
    s.write("two.md", BOTH);
    s.git("add", "two.md");
    ok(s.script("record.ts", ["two.md", "combined", "--reason", "both"]));
    ok(s.script("check-resolution.ts"));
    s.git("rebase", "--continue");
    ok(s.script("events.ts"));
    const recorded = events();
    expect(recorded.map((e) => [e.operation, e.path, e.branch])).toEqual([
      ["rebase", "one.md", "feature"],
      ["rebase", "two.md", "feature"],
    ]);
    const heads = s
      .git("rev-list", "--reverse", "main..feature")
      .trim()
      .split("\n");
    expect(recorded.map((e) => e.commit)).toEqual(heads);
  });
});

describe("a record that cannot be written when the next map replaces the snapshot", () => {
  it("keeps the snapshot pending, and events.ts records it once it can", () => {
    twoStops();
    expect(s.gitTry("rebase", "main").code).not.toBe(0);
    resolve("one.md", BOTH);
    expect(s.gitTry("rebase", "--continue").code).not.toBe(0);
    const file = eventsFile();
    symlinkSync(`${s.home}/nowhere`, file);
    const map = s.script("conflict-map.ts");
    ok(map);
    expect(map.stderr).toContain("is kept in");
    const pending = `${s.git("rev-parse", "--path-format=absolute", "--git-path", "jig").trim()}/pending`;
    expect(readdirSync(pending)).toHaveLength(1);

    const blocked = s.script("events.ts");
    ok(blocked, 3);
    rmSync(file);
    s.write("two.md", BOTH);
    s.git("add", "two.md");
    ok(s.script("record.ts", ["two.md", "combined", "--reason", "both"]));
    ok(s.script("check-resolution.ts"));
    s.git("rebase", "--continue");
    ok(s.script("events.ts"));
    expect(events().map((e) => e.path)).toEqual(["one.md", "two.md"]);
    expect(readdirSync(pending)).toEqual([]);
  });
});

describe("a path that merged cleanly", () => {
  it("has no event, though a decision was recorded for an adjustment to it", () => {
    s.commit("Add the lists", { "list.md": LIST, "clean.md": "x\n" });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Add b1", { "list.md": withItem("b1") });
    s.git("checkout", "-q", "main");
    s.commit("Add b2 and touch clean", {
      "list.md": withItem("b2"),
      "clean.md": "x\ny\n",
    });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    ok(s.script("conflict-map.ts"));
    s.write("list.md", BOTH);
    s.git("add", "list.md");
    ok(s.script("record.ts", ["list.md", "combined", "--reason", "both"]));
    s.write("clean.md", "x\ny\nadjusted\n");
    s.git("add", "clean.md");
    ok(s.script("record.ts", ["clean.md", "combined", "--reason", "adjusted"]));
    ok(s.script("check-resolution.ts"));
    s.git("commit", "-q", "--no-edit");
    ok(s.script("events.ts"));
    expect(events().map((e) => e.path)).toEqual(["list.md"]);
  });
});

describe("a lockfile", () => {
  it("is derived, with its regions counted", () => {
    s.commit("Add the lock", { "yarn.lock": LIST });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Lock b1", { "yarn.lock": withItem("b1") });
    s.git("checkout", "-q", "main");
    s.commit("Lock b2", { "yarn.lock": withItem("b2") });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    resolve("yarn.lock", BOTH, "regenerated", "regenerated");
    s.git("commit", "-q", "--no-edit");
    ok(s.script("events.ts"));
    expect(events()).toMatchObject([
      { path: "yarn.lock", cause: "derived", causes: ["derived"], regions: 1 },
    ]);
  });
});

describe("a cherry-pick and a revert", () => {
  it("records a cherry-pick", () => {
    s.commit("Add the list", { "list.md": LIST });
    s.git("checkout", "-q", "-b", "other");
    const picked = s.commit("Add b1", { "list.md": withItem("b1") });
    s.git("checkout", "-q", "main");
    s.commit("Add b2", { "list.md": withItem("b2") });
    expect(s.gitTry("cherry-pick", picked).code).not.toBe(0);
    resolve("list.md", BOTH);
    s.git("commit", "-q", "--no-edit");
    ok(s.script("events.ts"));
    expect(events()).toMatchObject([
      { operation: "cherry-pick", path: "list.md", cause: "append" },
    ]);
  });

  it("records a revert", () => {
    s.commit("Add the list", { "list.md": LIST });
    const added = s.commit("Add b1", { "list.md": withItem("b1") });
    s.commit("Rewrite the item", { "list.md": withItem("b1 again") });
    expect(s.gitTry("revert", "--no-edit", added).code).not.toBe(0);
    resolve("list.md", LIST, "the item is gone on purpose", "rewritten");
    s.git("commit", "-q", "--no-edit");
    ok(s.script("events.ts"));
    expect(events()).toMatchObject([
      { operation: "revert", path: "list.md", decision: "rewritten" },
    ]);
  });
});

describe("the cause that stands for a path", () => {
  const regions = (...causes: (typeof CAUSES)[number][]) =>
    causes.map((cause) => ({ cause }));

  it("is overlap or structural whenever the path has one", () => {
    expect(
      primaryCause(["append", "overlap"], regions("append", "overlap")),
    ).toBe("overlap");
    expect(primaryCause(["structural"], [])).toBe("structural");
  });

  it("is the cause of most regions otherwise, ties in cause order", () => {
    expect(
      primaryCause(["append", "tally"], regions("append", "tally", "tally")),
    ).toBe("tally");
    expect(primaryCause(["tally", "append"], regions("append", "tally"))).toBe(
      "tally",
    );
    expect(primaryCause(["derived"], [])).toBe("derived");
  });
});

describe("the regions of a file both sides added", () => {
  it("are counted, and the cause is overlap", () => {
    s.commit("Start", { "README.md": "x\n" });
    s.git("checkout", "-q", "-b", "feature");
    s.commit("Add notes", { "notes.md": "a\nb\n" });
    s.git("checkout", "-q", "main");
    s.commit("Add notes too", { "notes.md": "a\nc\n" });
    s.git("checkout", "-q", "feature");
    expect(s.gitTry("merge", "main").code).not.toBe(0);
    resolve("notes.md", "a\nb\nc\n");
    s.git("commit", "-q", "--no-edit");
    ok(s.script("events.ts"));
    expect(events()).toMatchObject([
      { path: "notes.md", cause: "overlap", regions: 1 },
    ]);
  });
});

/** A snapshot with only the operation `concludedCommit` reads. */
const operation = (
  kind: "rebase" | "merge",
  head: string,
  incoming: string,
): Snapshot =>
  ({ operation: { kind, head, incoming, base: null } }) as Snapshot;

describe("the commit an operation concluded with", () => {
  it("is the merge a rebase of merges recreates, with the rebased side as its second parent", () => {
    const base = s.commit("Base", { "a.md": "a\n" });
    s.git("checkout", "-q", "-b", "side");
    const side = s.commit("Side", { "side.md": "s\n" });
    s.git("checkout", "-q", "main");
    const onto = s.commit("Onto", { "onto.md": "o\n" });
    const tree = s.git("rev-parse", "HEAD^{tree}").trim();
    const merge = s
      .git("commit-tree", tree, "-p", onto, "-p", side, "-m", "Merge side")
      .trim();
    s.git("reset", "-q", "--hard", merge);
    expect(base).not.toBe(onto);
    expect(concludedCommit(s.root, operation("rebase", onto, side))).toBe(
      merge,
    );
  });

  it("is the commit that replaced the one a conflicting fixup was folded into", () => {
    const root = s.commit("Base", { "a.md": "a\n" });
    s.git("checkout", "-q", "-b", "fixups");
    const fixup = s.commit("fixup! one", { "a.md": "a\nfix\n" });
    s.git("checkout", "-q", "main");
    const one = s.commit("one", { "a.md": "a\none\n" });
    s.git("commit", "-q", "--amend", "-m", "one, with the fixup folded in");
    const amended = s.git("rev-parse", "HEAD").trim();
    expect(amended).not.toBe(one);
    expect(s.git("rev-parse", "HEAD^").trim()).toBe(root);
    expect(concludedCommit(s.root, operation("rebase", one, fixup))).toBe(
      amended,
    );
  });

  it("is that commit also when the rebase replayed more commits after it", () => {
    const root = s.commit("Base", { "a.md": "a\n" });
    s.git("checkout", "-q", "-b", "fixups");
    const fixup = s.commit("fixup! one", { "a.md": "a\nfix\n" });
    s.git("checkout", "-q", "main");
    const one = s.commit("one", { "a.md": "a\none\n" });
    s.git("commit", "-q", "--amend", "-m", "one, with the fixup folded in");
    const amended = s.git("rev-parse", "HEAD").trim();
    s.commit("two", { "b.md": "b\n" });
    expect(s.git("rev-parse", "HEAD~2").trim()).toBe(root);
    expect(concludedCommit(s.root, operation("rebase", one, fixup))).toBe(
      amended,
    );
  });

  it("is not the incoming commit itself, left above the stopped one by an aborted rebase", () => {
    s.commit("Base", { "a.md": "a\n" });
    const one = s.commit("one", { "a.md": "a\none\n" });
    const fixup = s.commit("fixup! one", { "a.md": "a\none\nfix\n" });
    expect(s.git("rev-parse", "HEAD^").trim()).toBe(one);
    expect(concludedCommit(s.root, operation("rebase", one, fixup))).toBeNull();
  });

  it("is not an ordinary commit that replaced the stopped one", () => {
    const root = s.commit("Base", { "a.md": "a\n" });
    s.git("checkout", "-q", "-b", "other");
    const picked = s.commit("Something else", { "a.md": "a\nx\n" });
    s.git("checkout", "-q", "main");
    const one = s.commit("one", { "a.md": "a\none\n" });
    s.git("commit", "-q", "--amend", "-m", "one, reworded");
    expect(s.git("rev-parse", "HEAD^").trim()).toBe(root);
    expect(
      concludedCommit(s.root, operation("rebase", one, picked)),
    ).toBeNull();
  });
});
