/**
 * The pure pieces of history.ts: git's version, the command line, merge-tree's
 * output, the resolution section, the line alignment and the cause rules.
 */
import { describe, expect, it } from "bun:test";
import { parseArgs } from "../scripts/history.ts";
import {
  edit,
  isAdjacent,
  isEcho,
  isPackedList,
  isSourceCode,
  type RegionContext,
  regionCause,
} from "../scripts/lib/causes.ts";
import {
  gitIsRecentEnough,
  NO_LAZY_FETCH_GIT,
  parseGitVersion,
  parseMergeTree,
  parseResolutionSection,
  subjectBranches,
} from "../scripts/lib/replay.ts";
import { weekOf } from "../scripts/lib/report.ts";

describe("git's version", () => {
  it("reads the forms git prints", () => {
    expect(parseGitVersion("git version 2.56.0\n")).toEqual([2, 56, 0]);
    expect(parseGitVersion("git version 2.39.3 (Apple Git-146)")).toEqual([
      2, 39, 3,
    ]);
    expect(parseGitVersion("git version 2.45.1.windows.1")).toEqual([2, 45, 1]);
    expect(parseGitVersion("git version 3.0")).toEqual([3, 0, 0]);
    expect(parseGitVersion("not git")).toBeNull();
  });

  it("needs 2.40 or later, and 2.45 or later to keep a partial clone from fetching", () => {
    expect(gitIsRecentEnough([2, 39, 9])).toBe(false);
    expect(gitIsRecentEnough([1, 99, 0])).toBe(false);
    expect(gitIsRecentEnough([2, 40, 0])).toBe(true);
    expect(gitIsRecentEnough([3, 0, 0])).toBe(true);
    expect(gitIsRecentEnough([2, 44, 3], NO_LAZY_FETCH_GIT)).toBe(false);
    expect(gitIsRecentEnough([2, 45, 0], NO_LAZY_FETCH_GIT)).toBe(true);
  });
});

describe("the command line", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");

  it("takes the last 30 days by default", () => {
    expect(parseArgs([], now)).toEqual({
      json: false,
      limit: 25,
      since: now - 30 * 86_400_000,
      until: null,
      label: "the last 30 days (2026-09-19 to 2026-10-19)",
    });
  });

  it("ends a bare --until date after that day", () => {
    expect(
      parseArgs(
        ["--since", "2026-01-01", "--until", "2026-01-31", "--json"],
        now,
      ),
    ).toMatchObject({
      json: true,
      since: Date.parse("2026-01-01T00:00:00Z"),
      until: Date.parse("2026-02-01T00:00:00Z"),
      label: "from 2026-01-01 to 2026-01-31",
    });
  });

  it("refuses what it cannot read", () => {
    for (const args of [
      ["--days"],
      ["--days", "x"],
      ["--limit", "-1"],
      ["--since", "2026-02-01", "--until", "2026-01-01"],
      ["--all", "--since", "2026-01-01"],
    ])
      expect(typeof parseArgs(args, now)).toBe("string");
  });
});

describe("merge-tree's output", () => {
  it("reads the stages and git's kinds of conflict per path", () => {
    const out = [
      "tree0",
      "100644 b1 1\tf",
      "100644 b2 2\tf",
      "100644 b3 3\tf",
      "100644 c1 1\tg",
      "100644 c2 2\tg",
      "",
      "1",
      "f",
      "Auto-merging",
      "Auto-merging f\n",
      "1",
      "f",
      "CONFLICT (contents)",
      "CONFLICT (content): Merge conflict in f\n",
      "1",
      "g",
      "CONFLICT (modify/delete)",
      "CONFLICT (modify/delete): g deleted in feat and modified in main.\n",
      "",
    ].join("\0");
    const parsed = parseMergeTree(out, false);
    expect(parsed.tree).toBe("tree0");
    expect(parsed.paths.map((p) => [p.path, p.conflicts])).toEqual([
      ["f", ["contents"]],
      ["g", ["modify/delete"]],
    ]);
    expect(parsed.paths[1]?.stages).toEqual({
      base: { mode: "100644", blob: "c1" },
      ours: { mode: "100644", blob: "c2" },
      theirs: null,
    });
  });

  it("reads a clean merge as no path", () => {
    expect(parseMergeTree("tree0\0", true)).toEqual({
      tree: "tree0",
      clean: true,
      paths: [],
    });
  });
});

describe("the Conflicts resolved: section", () => {
  it("reads every form check-resolution.ts writes", () => {
    const message = [
      "Merge branch 'main' into feature",
      "",
      "Conflicts resolved:",
      "- src/a.ts: combined — kept both.",
      "- src/b.ts: theirs — main renamed it: see c.ts.",
      "- bun.lock: regenerated (bun install --frozen-lockfile)",
      "- odd: name.txt: rewritten — new code (both intents). Dropped on purpose: the old helper",
      "- docs/x.md: combined",
      "",
      "Signed-off-by: someone",
      "- not: part of the section",
    ].join("\n");
    const found = parseResolutionSection(message);
    expect([...found.keys()]).toEqual([
      "src/a.ts",
      "src/b.ts",
      "bun.lock",
      "odd: name.txt",
      "docs/x.md",
    ]);
    expect(found.get("src/b.ts")).toEqual({
      decision: "theirs",
      reason: "main renamed it: see c.ts.",
      command: null,
      dropped: null,
    });
    expect(found.get("bun.lock")).toEqual({
      decision: "regenerated",
      reason: null,
      command: "bun install --frozen-lockfile",
      dropped: null,
    });
    expect(found.get("odd: name.txt")).toEqual({
      decision: "rewritten",
      reason: "new code (both intents).",
      command: null,
      dropped: "the old helper",
    });
    expect(found.get("docs/x.md")?.reason).toBeNull();
  });

  it("finds nothing in a message without one", () => {
    expect(
      parseResolutionSection("Merge branch 'x'\n\n- a: combined\n").size,
    ).toBe(0);
  });
});

describe("the cause rules", () => {
  const none: RegionContext = {
    inBase: true,
    file: { base: null, ours: null, theirs: null },
    release: { base: null, ours: null, theirs: null },
    netAbove: () => null,
  };

  it("aligns lines and names the changed stretches of the base", () => {
    expect(edit(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual({
      added: ["x", "d"],
      removed: ["b"],
      spans: [
        [1, 2],
        [3, 3],
      ],
    });
  });

  it("echo: identical sides, or containment with the shared lines in order; never a near match", () => {
    expect(isEcho({ base: ["a"], ours: ["b"], theirs: ["b"] })).toBe(true);
    expect(isEcho({ base: ["a"], ours: ["b", "c"], theirs: ["c", "b"] })).toBe(
      false,
    );
    expect(isEcho({ base: ["a"], ours: ["b."], theirs: ["b"] })).toBe(false);
  });

  it("packed-list: items added on both sides; a removed item is not", () => {
    expect(
      isPackedList({
        base: ["a, b and c"],
        ours: ["a, b, c and d"],
        theirs: ["a, b, c and e"],
      }),
    ).toBe(true);
    expect(
      isPackedList({
        base: ["[a, b]"],
        ours: ["[a, x]"],
        theirs: ["[a, b, c]"],
      }),
    ).toBe(false);
  });

  it("adjacent: insertions at one place overlap; a change beside the other's does not", () => {
    expect(
      isAdjacent({ base: ["a", "b"], ours: ["A", "b"], theirs: ["a", "B"] }),
    ).toBe(true);
    expect(
      isAdjacent({ base: ["a"], ours: ["x", "a"], theirs: ["y", "a"] }),
    ).toBe(false);
    expect(
      isAdjacent({ base: ["a", "b"], ours: ["A", "b"], theirs: ["A2", "B"] }),
    ).toBe(false);
  });

  it("tally needs the three files: without them a moved number is overlap", () => {
    expect(
      regionCause({ base: ["n: 1"], ours: ["n: 2"], theirs: ["n: 3"] }, none),
    ).toBe("overlap");
  });

  it("knows source code by its extension", () => {
    expect(isSourceCode("src/a.ts")).toBe(true);
    expect(isSourceCode("README.md")).toBe(false);
  });
});

it("names a week by its Monday", () => {
  expect(weekOf("2026-10-19T10:00:00+02:00")).toBe("2026-10-19");
  expect(weekOf("2026-10-25T23:00:00Z")).toBe("2026-10-19");
  expect(weekOf("2026-10-18T23:30:00Z")).toBe("2026-10-12");
});

it("reads the branches a merge's subject names", () => {
  expect(subjectBranches("Merge branch 'a' into b")).toEqual({
    theirs: "a",
    ours: "b",
  });
  expect(subjectBranches("Merge branch 'a'")).toEqual({
    theirs: "a",
    ours: null,
  });
  expect(
    subjectBranches("Merge remote-tracking branch 'origin/main' into feat/x"),
  ).toEqual({
    theirs: "origin/main",
    ours: "feat/x",
  });
  expect(
    subjectBranches("Merge pull request #12 from owner/fix/thing"),
  ).toEqual({
    theirs: "fix/thing",
    ours: null,
  });
  expect(subjectBranches("Add a thing")).toEqual({ theirs: null, ours: null });
});
