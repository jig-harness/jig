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
  isSequence,
  isSourceCode,
  isVersion,
  type RegionContext,
  regionCause,
} from "../scripts/lib/causes.ts";
import {
  gitIsRecentEnough,
  markerSizeOf,
  NO_LAZY_FETCH_GIT,
  parseGitVersion,
  parseMergeTree,
  parseResolutionSection,
  quoteAlternate,
  subjectBranches,
} from "../scripts/lib/replay.ts";
import { parseObligations } from "../scripts/lib/obligations.ts";
import {
  buildReport,
  type MergeRecord,
  renderReport,
  weekOf,
} from "../scripts/lib/report.ts";

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

  it("needs 2.43 or later, and 2.45 or later to keep a partial clone from fetching", () => {
    expect(gitIsRecentEnough([2, 42, 9])).toBe(false);
    expect(gitIsRecentEnough([1, 99, 0])).toBe(false);
    expect(gitIsRecentEnough([2, 43, 0])).toBe(true);
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
      ["--since", "2026-02-30"],
      ["--since", "1"],
      ["--since", "2026-01-01T00:00"],
      ["--until", "2026-13-01"],
      ["--days", "1000000000"],
      ["--days", "9".repeat(400)],
      ["--limit", "9".repeat(400)],
    ])
      expect(typeof parseArgs(args, now)).toBe("string");
  });

  it("reads a year below 100 as itself", () => {
    expect(parseArgs(["--since", "0099-01-01"], now)).toMatchObject({
      since: Date.parse("0099-01-01T00:00:00Z"),
    });
  });

  it("reads an ISO 8601 time with its offset", () => {
    expect(
      parseArgs(["--since", "2026-01-01T10:00:00+02:00"], now),
    ).toMatchObject({ since: Date.parse("2026-01-01T08:00:00Z") });
  });
});

describe("the marker size, read as the running git reads it", () => {
  const values = [
    "12",
    "12suffix",
    "12.5",
    " +9",
    "-3",
    "0",
    "unspecified",
    "set",
    "99999999999",
  ];
  it("before 2.48: the leading digits, anything after ignored", () => {
    expect(values.map((v) => markerSizeOf(v, [2, 47, 0]))).toEqual([
      12, 12, 12, 9, 7, 7, 7, 7, 7,
    ]);
  });
  it("from 2.48: a whole integer only, else the default", () => {
    expect(values.map((v) => markerSizeOf(v, [2, 48, 0]))).toEqual([
      12, 7, 7, 9, 7, 7, 7, 7, 7,
    ]);
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

  it("keeps a conflict git reports only in a message", () => {
    const out = [
      "tree0",
      "",
      "2",
      "old/f",
      "new/f",
      "CONFLICT (file location)",
      "CONFLICT (file location): old/f added in feat inside a directory that was renamed in main.\n",
      "",
    ].join("\0");
    const parsed = parseMergeTree(out, false);
    expect(parsed.paths.map((p) => [p.path, p.conflicts, p.stages])).toEqual([
      ["old/f", ["file location"], { base: null, ours: null, theirs: null }],
      ["new/f", ["file location"], { base: null, ours: null, theirs: null }],
    ]);
  });

  it("keeps a message-only path when another path of the message has stages", () => {
    const out = [
      "tree0",
      "100644 b2 2\tnew/f",
      "",
      "2",
      "old/f",
      "new/f",
      "CONFLICT (file location)",
      "CONFLICT (file location): old/f added in feat inside a directory that was renamed in main.\n",
      "",
    ].join("\0");
    const parsed = parseMergeTree(out, false);
    expect(parsed.paths.map((p) => [p.path, p.conflicts])).toEqual([
      ["new/f", ["file location"]],
      ["old/f", ["file location"]],
    ]);
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
    release: { base: [], ours: [], theirs: [] },
    prose: false,
    netAbove: () => null,
  };
  const prose: RegionContext = { ...none, prose: true };

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
      isPackedList(
        {
          base: ["a, b and c"],
          ours: ["a, b, c and d"],
          theirs: ["a, b, c and e"],
        },
        prose,
      ),
    ).toBe(true);
    expect(
      isPackedList(
        {
          base: ["[a, b]"],
          ours: ["[a, x]"],
          theirs: ["[a, b, c]"],
        },
        none,
      ),
    ).toBe(false);
  });

  it("packed-list: a changed separator is not an added item", () => {
    expect(
      isPackedList(
        {
          base: ["return a | b;"],
          ours: ["return a | b | c;"],
          theirs: ["return a, b, d;"],
        },
        none,
      ),
    ).toBe(false);
    expect(
      isPackedList(
        {
          base: ["a, b and c"],
          ours: ["a, b, c and d"],
          theirs: ["a, b, c and e"],
        },
        none,
      ),
    ).toBe(false);
    expect(
      isPackedList(
        { base: ["a or b"], ours: ["a and b and c"], theirs: ["a, b, d"] },
        prose,
      ),
    ).toBe(false);
  });

  it("packed-list: a change to an existing item is not an added item", () => {
    expect(
      isPackedList(
        {
          base: ["return [a, b];"],
          ours: ["return [a, b, c];"],
          theirs: ["return [a, b(), d];"],
        },
        none,
      ),
    ).toBe(false);
    expect(
      isPackedList(
        {
          base: ["return [a, b];"],
          ours: ["return [a, b, c];"],
          theirs: ["return [d, a, b];"],
        },
        none,
      ),
    ).toBe(true);
  });

  it("packed-list: an inserted item stands at an item boundary and is whole", () => {
    const both = (base: string, ours: string, theirs: string) =>
      isPackedList({ base: [base], ours: [ours], theirs: [theirs] }, none);
    // A trailing separator does not make `+ d` an item: `b` changed.
    expect(
      both("return [a, b];", "return [a, b, c];", "return [a, b + d,];"),
    ).toBe(false);
    // An item added inside an expression changes it.
    expect(both("f(a, b + e);", "f(a, b + e, c);", "f(a, b, x + e);")).toBe(
      false,
    );
    expect(both("f(a, b + e);", "f(a, b + e, c);", "f(a, x, b + e);")).toBe(
      true,
    );
    // An added item closes every bracket it opens.
    expect(both("f(a, b);", "f(a, b, c);", "f(a, b, g(x);")).toBe(false);
    expect(both("f(a, b);", "f(a, b, c);", "f(a, b, g(x, y));")).toBe(true);
    // A separator alone adds no item.
    expect(both("f(a, b);", "f(a, b, c);", "f(a, b,);")).toBe(false);
    // Items added after a trailing separator keep it.
    expect(
      both("return [a, b,];", "return [a, b, c,];", "return [a, b, d,];"),
    ).toBe(true);
    expect(both("a, b,", "a, b, c,", "a, b, d,")).toBe(true);
    expect(
      both("return [a, b,];", "return [a, b, c,];", "return [a, b,,];"),
    ).toBe(false);
  });

  it("packed-list: a code line is read as its language reads it, or not at all", () => {
    const both = (base: string, ours: string, theirs: string) =>
      isPackedList({ base: [base], ours: [ours], theirs: [theirs] }, none);
    // A template literal escapes a backtick inside it.
    expect(
      both(
        "return [`a\\`b`, c];",
        "return [`a\\`b`, c, d];",
        "return [`a\\`b`, c, e];",
      ),
    ).toBe(true);
    expect(
      both(
        "return [`a,b`, c];",
        "return [`a,x,b`, c];",
        "return [`a,y,b`, c];",
      ),
    ).toBe(false);
    // A `/` may open a regular expression literal: the items cannot be told.
    expect(
      both(
        "return [/a,b/, c];",
        "return [/a,x,b/, c];",
        "return [/a,y,b/, c];",
      ),
    ).toBe(false);
    expect(
      both(
        "return [a, b]; // c",
        "return [a, b, d]; // c",
        "return [a, b, e]; // c",
      ),
    ).toBe(false);
  });

  it("packed-list: a code span delimited by a run of backticks is one item", () => {
    expect(
      isPackedList(
        {
          base: ["Use ``a,b``."],
          ours: ["Use ``a,c,b``."],
          theirs: ["Use ``a,d,b``."],
        },
        prose,
      ),
    ).toBe(false);
    expect(
      isPackedList(
        {
          base: ["Use ``a`b``, c."],
          ours: ["Use ``a`b``, c, d."],
          theirs: ["Use ``a`b``, c, e."],
        },
        prose,
      ),
    ).toBe(true);
  });

  it("packed-list: a quoted literal is one item; a change inside it is not an added item", () => {
    expect(
      isPackedList(
        {
          base: ['return ["a,b"];'],
          ours: ['return ["a,c,b"];'],
          theirs: ['return ["a,d,b"];'],
        },
        none,
      ),
    ).toBe(false);
    expect(
      isPackedList(
        {
          base: ['return ["a b", c];'],
          ours: ['return ["a  b", c, d];'],
          theirs: ['return ["a b", c, e];'],
        },
        none,
      ),
    ).toBe(false);
    expect(
      isPackedList(
        {
          base: ["return ['a,b', c];"],
          ours: ["return ['a,b', c, d];"],
          theirs: ["return ['a,b', c, 'e,f'];"],
        },
        none,
      ),
    ).toBe(true);
    // A quote that closes nowhere: the items cannot be told.
    expect(
      isPackedList(
        {
          base: ['x = "a, b'],
          ours: ['x = "a, b, c'],
          theirs: ['x = "a, b, d'],
        },
        none,
      ),
    ).toBe(false);
    // In prose an apostrophe opens nothing.
    expect(
      isPackedList(
        {
          base: ["Jig's a, b and c"],
          ours: ["Jig's a, b, c and d"],
          theirs: ["Jig's a, b, c and e"],
        },
        prose,
      ),
    ).toBe(true);
  });

  it("sequence: only when both sides add; a changed line is not explained by the collision", () => {
    const ctx = {
      ...none,
      file: { base: ["retries: 3"], ours: null, theirs: null },
    };
    expect(
      isSequence(
        {
          base: ["retries: 3"],
          ours: ["retries: 4 # ours"],
          theirs: ["retries: 4 # theirs"],
        },
        ctx,
      ),
    ).toBe(false);
    const entries = {
      ...none,
      file: { base: ["001 a", "002 b"], ours: null, theirs: null },
    };
    expect(
      isSequence({ base: [], ours: ["003 c"], theirs: ["003 d"] }, entries),
    ).toBe(true);
    expect(
      isSequence(
        {
          base: ["x = 1"],
          ours: ["003 c", "x = 2"],
          theirs: ["003 d", "x = 3"],
        },
        entries,
      ),
    ).toBe(false);
  });

  it("version: only the configured field's line is the release version", () => {
    const field = (line: string, version: string) => {
      const start = line.indexOf(version);
      return { version, line, start, end: start + version.length };
    };
    const pkg = (v: string) => ["{", `  "version": "${v}",`, "}"];
    const ctx = (ours: string[], theirs: string[]): RegionContext => ({
      ...none,
      file: { base: null, ours, theirs },
      release: {
        base: [],
        ours: [field('  "version": "1.1.0",', "1.1.0")],
        theirs: [field('  "version": "1.0.1",', "1.0.1")],
      },
    });
    expect(
      isVersion(
        {
          base: ['  "version": "1.0.0",'],
          ours: ['  "version": "1.1.0",'],
          theirs: ['  "version": "1.0.1",'],
        },
        ctx(pkg("1.1.0"), pkg("1.0.1")),
      ),
    ).toBe(true);
    // The same text twice in the file: the region's line may be the other one.
    expect(
      isVersion(
        {
          base: ['  "version": "1.0.0",'],
          ours: ['  "version": "1.1.0",'],
          theirs: ['  "version": "1.0.1",'],
        },
        ctx(
          [...pkg("1.1.0"), '  "version": "1.1.0",'],
          [...pkg("1.0.1"), '  "version": "1.0.1",'],
        ),
      ),
    ).toBe(false);
    // Another line with the same value is not the field.
    expect(
      isVersion(
        {
          base: ['    "lib": "1.0.0"'],
          ours: ['    "lib": "1.1.0"'],
          theirs: ['    "lib": "1.0.1"'],
        },
        ctx(pkg("1.1.0"), pkg("1.0.1")),
      ),
    ).toBe(false);
  });

  it("version: every configured field of the file is masked, each on its own", () => {
    const field = (line: string, version: string) => {
      const start = line.indexOf(version);
      return { version, line, start, end: start + version.length };
    };
    const chart = (v: string, app: string) => [
      `version: ${v}`,
      `appVersion: ${app}`,
    ];
    const ctx: RegionContext = {
      ...none,
      file: {
        base: null,
        ours: chart("1.1.0", "2.1.0"),
        theirs: chart("1.0.1", "2.0.1"),
      },
      release: {
        base: [],
        ours: [
          field("version: 1.1.0", "1.1.0"),
          field("appVersion: 2.1.0", "2.1.0"),
        ],
        theirs: [
          field("version: 1.0.1", "1.0.1"),
          field("appVersion: 2.0.1", "2.0.1"),
        ],
      },
    };
    expect(
      isVersion(
        {
          base: chart("1.0.0", "2.0.0"),
          ours: chart("1.1.0", "2.1.0"),
          theirs: chart("1.0.1", "2.0.1"),
        },
        ctx,
      ),
    ).toBe(true);
    // Two fields on one line are masked from its end, so each keeps its offsets.
    const line = (v: string, app: string) =>
      `{"version": "${v}", "appVersion": "${app}"}`;
    const pair = (v: string, app: string) => {
      const text = line(v, app);
      const at = text.indexOf(app, text.indexOf("appVersion"));
      return [
        field(text, v),
        { version: app, line: text, start: at, end: at + app.length },
      ];
    };
    expect(
      isVersion(
        {
          base: [line("1.0.0", "2.0.0")],
          ours: [line("1.1.0", "2.1.0")],
          theirs: [line("1.0.1", "2.0.1")],
        },
        {
          ...none,
          file: {
            base: null,
            ours: [line("1.1.0", "2.1.0")],
            theirs: [line("1.0.1", "2.0.1")],
          },
          release: {
            base: [],
            ours: pair("1.1.0", "2.1.0"),
            theirs: pair("1.0.1", "2.0.1"),
          },
        },
      ),
    ).toBe(true);
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
  // A year below 100 stays itself: 0099-01-01 is a Thursday.
  expect(weekOf("0099-01-01T00:00:00Z")).toBe("0098-12-29");
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

it("lets the obligations reader accept the history report's hotspot threshold", () => {
  expect(
    parseObligations({ generated: [], hotspot_min_merges: 2, obligations: [] }),
  ).toEqual([]);
});

it("quotes an alternate object directory that holds the list separator", () => {
  const sep = process.platform === "win32" ? ";" : ":";
  expect(quoteAlternate("/repo/.git/objects")).toBe("/repo/.git/objects");
  expect(quoteAlternate(`/tmp/project${sep}copy/.git/objects`)).toBe(
    `"/tmp/project${sep}copy/.git/objects"`,
  );
  expect(quoteAlternate('"odd\\dir')).toBe('"\\"odd\\\\dir"');
});

describe("the report", () => {
  const record = (date: string, conflicted: boolean): MergeRecord => ({
    operation: "merge",
    commit: date,
    parents: ["a", "b"],
    date,
    subject: "Merge",
    pullRequest: null,
    branches: { theirs: null, ours: null },
    parentHeads: { ours: [], theirs: [] },
    conflicted,
    mechanical: conflicted ? false : null,
    paths: conflicted
      ? [
          {
            path: "f",
            kind: "both-modified",
            conflicts: ["contents"],
            class: "text",
            causes: ["overlap"],
            regions: [],
            mechanical: false,
            resolution: null,
          },
        ]
      : [],
    unmatchedResolutions: [],
  });
  const now = new Date("2026-10-19T12:00:00Z");
  const range = { since: "2026-10-01T00:00:00.000Z", until: null, label: "x" };
  const build = (merges: MergeRecord[], skipped = 0) =>
    buildReport({
      range,
      hotspotMinMerges: 3,
      merges,
      skipped: Array.from({ length: skipped }, (_, i) => ({
        commit: `s${i}`,
        date: "2026-10-05T00:00:00Z",
        subject: "Merge",
        reason: "replay-failed" as const,
        detail: "missing object",
      })),
      confidence: null,
      now,
    });

  it("takes a path's last conflict by instant, not by text", () => {
    const report = build([
      record("2026-10-19T09:00:00Z", true),
      record("2026-10-19T10:00:00+02:00", true),
    ]);
    expect(report.paths[0]?.lastConflict).toBe("2026-10-19T09:00:00Z");
  });

  it("gives a merge dated after now its week", () => {
    const report = build([record("2026-11-03T00:00:00Z", false)]);
    expect(report.weeks.at(-1)).toMatchObject({
      week: "2026-11-02",
      merges: 1,
    });
    expect(report.weeks.reduce((n, w) => n + w.merges, 0)).toBe(1);
  });

  it("shows the weeks when no merge conflicted", () => {
    const text = renderReport(
      build([record("2026-10-05T00:00:00Z", false)]),
      25,
    );
    expect(text).toContain("No replayed merge conflicted.");
    expect(text).toContain("Per week, conflicted merges by cause:");
    expect(text).toContain("2026-10-05  0 of 1 merge conflicted");
  });

  it("lists the weeks of a range in a year below 100", () => {
    const report = buildReport({
      range: {
        since: "0099-01-01T00:00:00.000Z",
        until: "0099-01-31T00:00:00.000Z",
        label: "x",
      },
      hotspotMinMerges: 3,
      merges: [record("0099-01-12T00:00:00Z", false)],
      skipped: [],
      confidence: null,
      now,
    });
    expect(report.weeks.map((w) => w.week)).toEqual([
      "0098-12-29",
      "0099-01-05",
      "0099-01-12",
      "0099-01-19",
      "0099-01-26",
    ]);
    expect(report.weeks[2]?.merges).toBe(1);
  });

  it("does not call a range clean when every merge was skipped", () => {
    const text = renderReport(build([], 2), 25);
    expect(text).toContain("No merge in the range was replayed");
    expect(text).not.toContain("conflicted.");
  });
});
