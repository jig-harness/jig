/**
 * history.ts against scratch repositories built so that each merge conflicts
 * with one cause: the replay, the cause rules, the resolution section, the
 * range, the hotspot threshold, the JSON shape, and the guarantee that the
 * repository is left as it was.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import type { MergeRecord, PathRecord, Report } from "../scripts/lib/report.ts";
import { type Run, Scratch } from "./scratch.ts";

type Files = Record<string, string | Uint8Array | null>;

let s: Scratch;
let branches = 0;

beforeEach(() => {
  s = new Scratch("resolve-conflicts-history-");
  // The child reads no person's configuration file.
  s.env.JIG_HOME = join(s.home, "jig-home");
  branches = 0;
});
afterEach(() => s.cleanup());

function put(files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) s.git("rm", "-q", "--", path);
    else if (typeof content === "string") s.write(path, content);
    else {
      s.write(path, "");
      writeFileSync(join(s.root, path), content);
    }
  }
}

function commitAll(message: string, files: Files): string {
  put(files);
  s.git("add", "-A");
  s.git("commit", "-q", "--allow-empty", "-m", message);
  return s.git("rev-parse", "HEAD").trim();
}

/**
 * On `main`: commit `base`, branch off and commit `theirs` there, commit
 * `ours` on main, then record a merge commit of the two (ours' tree, the
 * message given) without running the merge, so the replay alone decides
 * what conflicted.
 */
function merge(
  base: Files,
  ours: Files,
  theirs: Files,
  message = "Merge branch 'feature'",
): MergeRecord & { parentsAre: [string, string] } {
  commitAll("base", base);
  const branch = `feature-${++branches}`;
  s.git("checkout", "-q", "-b", branch);
  const theirsCommit = commitAll("theirs", theirs);
  s.git("checkout", "-q", "main");
  const oursCommit = commitAll("ours", ours);
  const commit = s
    .git(
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      oursCommit,
      "-p",
      theirsCommit,
      "-m",
      message,
    )
    .trim();
  s.git("reset", "-q", "--hard", commit);
  return { commit, parentsAre: [oursCommit, theirsCommit] } as MergeRecord & {
    parentsAre: [string, string];
  };
}

function run(args: string[] = []): Run {
  return s.script("history.ts", args);
}

function report(args: string[] = ["--all"]): Report {
  const r = run(["--json", ...args]);
  expectSpawnExit(
    { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
    0,
    "history.ts",
  );
  return JSON.parse(r.stdout) as Report;
}

function pathOf(rep: Report, path: string): PathRecord {
  for (const m of rep.merges)
    for (const p of m.paths) if (p.path === path) return p;
  throw new Error(`no conflicted ${path} in ${JSON.stringify(rep.merges)}`);
}

function causesOf(path: string, rep = report()): string[] {
  return pathOf(rep, path).regions.map((r) => r.cause);
}

describe("causes, one scratch merge each", () => {
  it("derived: a lockfile, and a file the configuration declares generated", () => {
    s.overlay(
      'resolve_conflicts:\n  generated:\n    - paths: ["gen/**"]\n      command: make gen\n',
    );
    merge(
      { "bun.lock": "a\nb\n", "gen/out.txt": "1\n" },
      { "bun.lock": "a\nours\n", "gen/out.txt": "2\n" },
      { "bun.lock": "a\ntheirs\n", "gen/out.txt": "3\n" },
    );
    const rep = report();
    expect(pathOf(rep, "bun.lock")).toMatchObject({
      class: "lockfile",
      causes: ["derived"],
    });
    expect(pathOf(rep, "gen/out.txt")).toMatchObject({
      class: "generated",
      causes: ["derived"],
    });
    expect(rep.merges[0]?.mechanical).toBe(true);
  });

  it("structural: a modify/delete and a binary file, with git's own kind", () => {
    merge(
      { "gone.txt": "x\n", "logo.bin": new Uint8Array([0, 1, 2]) },
      { "gone.txt": "changed\n", "logo.bin": new Uint8Array([0, 1, 3]) },
      { "gone.txt": null, "logo.bin": new Uint8Array([0, 1, 4]) },
    );
    const rep = report();
    const gone = pathOf(rep, "gone.txt");
    expect(gone).toMatchObject({
      kind: "deleted-by-theirs",
      causes: ["structural"],
      regions: [],
    });
    expect(gone.conflicts).toContain("modify/delete");
    const logo = pathOf(rep, "logo.bin");
    expect(logo).toMatchObject({ class: "binary", causes: ["structural"] });
    expect(logo.conflicts).toContain("binary");
    expect(rep.merges[0]?.mechanical).toBe(false);
  });

  it("echo: one side's edit is already in the other", () => {
    merge(
      { "f.txt": "top\nx = 1\nend\n" },
      { "f.txt": "top\nx = 2\ny = 3\nend\n" },
      { "f.txt": "top\nx = 2\nend\n" },
    );
    expect(causesOf("f.txt")).toEqual(["echo"]);
  });

  it("echo needs the contained edit to add a line: a removal inside a rewrite is overlap", () => {
    merge(
      { "f.txt": "top\na\nb\nc\nend\n" },
      { "f.txt": "top\na\nc\nend\n" },
      { "f.txt": "top\nall new\nend\n" },
    );
    expect(causesOf("f.txt")).toEqual(["overlap"]);
  });

  it("version: the release version the release step writes, and a date stamp", () => {
    s.overlay(
      "changelog:\n  file: CHANGELOG.md\n  version:\n    files:\n      - { path: package.json, key: version }\n",
    );
    const pkg = (v: string) => `{\n  "name": "x",\n  "version": "${v}"\n}\n`;
    merge(
      {
        "package.json": pkg("1.0.0"),
        "doc.md": "# Doc\n\nlast_updated: 2026-01-01\n",
      },
      {
        "package.json": pkg("1.1.0"),
        "doc.md": "# Doc\n\nlast_updated: 2026-02-01\n",
      },
      {
        "package.json": pkg("1.0.1"),
        "doc.md": "# Doc\n\nlast_updated: 2026-03-01\n",
      },
    );
    const rep = report();
    expect(causesOf("package.json", rep)).toEqual(["version"]);
    expect(causesOf("doc.md", rep)).toEqual(["version"]);
  });

  it("version: a dependency's version, or a version file nobody releases, stays overlap", () => {
    const pkg = (v: string, dep: string) =>
      `{\n  "name": "x",\n  "version": "${v}",\n  "dependencies": {\n    "lib": "${dep}"\n  }\n}\n`;
    merge(
      { "package.json": pkg("1.0.0", "^1.0.0") },
      { "package.json": pkg("1.0.0", "^1.2.0") },
      { "package.json": pkg("1.0.0", "^1.3.0") },
    );
    expect(causesOf("package.json")).toEqual(["overlap"]);
    merge(
      { "VERSION.json": '{ "version": "1.0.0" }\n' },
      { "VERSION.json": '{ "version": "1.1.0" }\n' },
      { "VERSION.json": '{ "version": "1.0.1" }\n' },
    );
    expect(causesOf("VERSION.json")).toEqual(["overlap"]);
  });

  it("sequence: both sides add the next ordinal", () => {
    merge(
      { "migrations.txt": "001_init\n002_users\n" },
      { "migrations.txt": "001_init\n002_users\n003_orders\n" },
      { "migrations.txt": "001_init\n002_users\n003_items\n" },
    );
    expect(causesOf("migrations.txt")).toEqual(["sequence"]);
  });

  it("tally: a count of the file's own lines; a setting is overlap", () => {
    const list = (count: number, items: string[]) =>
      `Count: ${count}\nretries: 3\n\nIntro.\n\n${items.map((i) => `- ${i}`).join("\n")}\n`;
    merge(
      { "list.md": list(3, ["a", "b", "c"]) },
      { "list.md": list(4, ["a", "b", "c", "d"]) },
      { "list.md": list(5, ["a", "b", "c", "e", "f"]) },
    );
    expect(causesOf("list.md")).toEqual(["tally", "append"]);
    merge(
      { "settings.txt": "name: x\nretries: 3\nend\n" },
      { "settings.txt": "name: x\nretries: 4\nend\n" },
      { "settings.txt": "name: x\nretries: 5\nend\n" },
    );
    expect(causesOf("settings.txt")).toEqual(["overlap"]);
  });

  it("tally: a stored line number moved by the lines each side added above it", () => {
    const lines = (top: string[], middle: string[], anchor: number) =>
      [
        ...top,
        "l1",
        "l2",
        "l3",
        "l4",
        "l5",
        "l6",
        ...middle,
        "l7",
        "l8",
        "",
        `anchor: line ${anchor}`,
        "",
      ].join("\n");
    merge(
      { "register.txt": lines([], [], 4) },
      { "register.txt": lines(["o1"], ["o2"], 5) },
      { "register.txt": lines(["t1", "t2"], [], 6) },
    );
    expect(causesOf("register.txt")).toEqual(["append", "tally"]);
  });

  it("append: both sides add at the same place; in code the remedy is a question", () => {
    merge(
      { "notes.md": "a\n", "src/x.ts": "export const a = 1;\n" },
      {
        "notes.md": "a\nb\n",
        "src/x.ts": "export const a = 1;\nexport const b = 2;\n",
      },
      {
        "notes.md": "a\nc\n",
        "src/x.ts": "export const a = 1;\nexport const c = 3;\n",
      },
    );
    const rep = report();
    expect(causesOf("notes.md", rep)).toEqual(["append"]);
    expect(causesOf("src/x.ts", rep)).toEqual(["append"]);
    const remedy = (path: string) =>
      rep.paths.find((p) => p.path === path)?.remedy ?? "";
    expect(remedy("src/x.ts")).toContain("?");
    expect(remedy("notes.md")).not.toContain("?");
  });

  it("packed-list: each side adds an item to a list on one line", () => {
    merge(
      { "skills.yaml": "name: x\nskills: [audit, review]\nend: y\n" },
      { "skills.yaml": "name: x\nskills: [audit, review, decide]\nend: y\n" },
      { "skills.yaml": "name: x\nskills: [audit, review, reflect]\nend: y\n" },
    );
    expect(causesOf("skills.yaml")).toEqual(["packed-list"]);
  });

  it("adjacent: the changed lines touch without overlapping", () => {
    merge(
      { "pair.txt": "top\na\nb\nend\n" },
      { "pair.txt": "top\nA\nb\nend\n" },
      { "pair.txt": "top\na\nB\nend\n" },
    );
    expect(causesOf("pair.txt")).toEqual(["adjacent"]);
  });

  it("overlap: both sides changed the same line", () => {
    merge({ "one.txt": "x\n" }, { "one.txt": "y\n" }, { "one.txt": "z\n" });
    const rep = report();
    expect(causesOf("one.txt", rep)).toEqual(["overlap"]);
    expect(rep.merges[0]?.mechanical).toBe(false);
  });

  it("one overlap region beside an append keeps the path and the merge from being mechanical", () => {
    const text = (first: string, last: string[]) =>
      [first, "k1", "k2", "k3", "k4", ...last, ""].join("\n");
    merge(
      { "mixed.txt": text("x", []), "only-append.txt": "a\n" },
      { "mixed.txt": text("y", ["ours"]), "only-append.txt": "a\nb\n" },
      { "mixed.txt": text("z", ["theirs"]), "only-append.txt": "a\nc\n" },
    );
    const rep = report();
    const mixed = pathOf(rep, "mixed.txt");
    expect(mixed.regions.map((r) => r.cause)).toEqual(["overlap", "append"]);
    expect(mixed.mechanical).toBe(false);
    expect(pathOf(rep, "only-append.txt").mechanical).toBe(true);
    expect(rep.merges[0]?.mechanical).toBe(false);
    expect(rep.totals.mechanical).toBe(0);
  });
});

describe("the merge record", () => {
  it("attaches each path's decision and reason from the Conflicts resolved: section", () => {
    merge(
      { "a.txt": "x\n", "bun.lock": "1\n" },
      { "a.txt": "y\n", "bun.lock": "2\n" },
      { "a.txt": "z\n", "bun.lock": "3\n" },
      [
        "Merge branch 'feature'",
        "",
        "Conflicts resolved:",
        "- a.txt: combined — kept y from main and z from the branch.",
        "- bun.lock: regenerated (bun install)",
        "- elsewhere.txt: theirs — the branch's version supersedes it.",
        "",
      ].join("\n"),
    );
    const rep = report();
    expect(pathOf(rep, "a.txt").resolution).toEqual({
      decision: "combined",
      reason: "kept y from main and z from the branch.",
      command: null,
      dropped: null,
    });
    expect(pathOf(rep, "bun.lock").resolution).toMatchObject({
      decision: "regenerated",
      command: "bun install",
    });
    expect(rep.merges[0]?.unmatchedResolutions).toEqual([
      {
        path: "elsewhere.txt",
        decision: "theirs",
        reason: "the branch's version supersedes it.",
        command: null,
        dropped: null,
      },
    ]);
  });

  it("records parents, the subject's pull request, a parent that is a fetched pull-request head, and clean merges", () => {
    const conflicted = merge(
      { "a.txt": "x\n" },
      { "a.txt": "y\n" },
      { "a.txt": "z\n" },
      "Merge pull request #7 from owner/feature",
    );
    s.git("update-ref", "refs/pull/7/head", conflicted.parentsAre[1]);
    merge({ "b.txt": "1\n" }, { "c.txt": "2\n" }, { "d.txt": "3\n" });
    const rep = report();
    const byCommit = new Map(rep.merges.map((m) => [m.commit, m]));
    const first = byCommit.get(conflicted.commit) as MergeRecord;
    expect(first.parents).toEqual(conflicted.parentsAre);
    expect(first.pullRequest).toBe(7);
    expect(first.parentHeads.theirs).toEqual([
      { ref: "refs/pull/7/head", number: 7 },
    ]);
    expect(first.operation).toBe("merge");
    expect(first.branches).toEqual({ theirs: "feature", ours: null });
    expect(rep.totals).toMatchObject({ merges: 2, conflicted: 1 });
    expect(rep.merges.filter((m) => !m.conflicted)).toHaveLength(1);
  });

  it("leaves out the stash and a forge's synthetic test merges", () => {
    merge({ "a.txt": "x\n" }, { "a.txt": "y\n" }, { "a.txt": "z\n" });
    const tree = s.git("rev-parse", "HEAD^{tree}").trim();
    const synthetic = s
      .git("commit-tree", tree, "-p", "HEAD", "-p", "HEAD~1", "-m", "synthetic")
      .trim();
    s.git("update-ref", "refs/pull/9/merge", synthetic);
    s.git("update-ref", "refs/remotes/origin/pull/10/merge", synthetic);
    s.git(
      "update-ref",
      "refs/remotes/origin/merge-requests/11/merge",
      synthetic,
    );
    s.write("a.txt", "dirty\n");
    s.git("stash", "-q");
    expect(report().totals.merges).toBe(1);
  });

  it("skips an octopus merge and says so", () => {
    commitAll("base", { "a.txt": "a\n" });
    const tips = ["x", "y"].map((name) => {
      s.git("checkout", "-q", "-b", name, "main");
      return commitAll(name, { [`${name}.txt`]: `${name}\n` });
    });
    s.git("checkout", "-q", "main");
    const tree = s.git("rev-parse", "HEAD^{tree}").trim();
    const octopus = s
      .git(
        "commit-tree",
        tree,
        "-p",
        "HEAD",
        "-p",
        tips[0] as string,
        "-p",
        tips[1] as string,
        "-m",
        "octopus",
      )
      .trim();
    s.git("reset", "-q", "--hard", octopus);
    const rep = report();
    expect(rep.totals).toMatchObject({ merges: 0, skipped: 1 });
    expect(rep.skipped[0]).toMatchObject({
      commit: octopus,
      reason: "octopus",
    });
  });

  it("replays a merge of unrelated histories, and a repository with no commit; a file both sides added is overlap, not append", () => {
    const empty = report();
    expect(empty.totals).toMatchObject({ merges: 0, conflicted: 0 });
    const ours = commitAll("root one", { "a.txt": "one\n" });
    s.git("checkout", "-q", "--orphan", "other");
    s.git("rm", "-q", "-rf", ".");
    const theirs = commitAll("root two", { "a.txt": "two\n" });
    s.git("checkout", "-q", "main");
    const commit = s
      .git("commit-tree", "HEAD^{tree}", "-p", ours, "-p", theirs, "-m", "join")
      .trim();
    s.git("reset", "-q", "--hard", commit);
    const rep = report();
    expect(pathOf(rep, "a.txt")).toMatchObject({
      kind: "both-added",
      causes: ["overlap"],
      mechanical: false,
    });
  });
});

describe("the report", () => {
  function at(date: string, body: () => void): void {
    s.env.GIT_COMMITTER_DATE = date;
    s.env.GIT_AUTHOR_DATE = date;
    try {
      body();
    } finally {
      delete s.env.GIT_COMMITTER_DATE;
      delete s.env.GIT_AUTHOR_DATE;
    }
  }
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("covers the last 30 days by default, and --days, --since/--until or --all on request", () => {
    at(iso(100 * DAY), () =>
      merge({ "a.txt": "x\n" }, { "a.txt": "y\n" }, { "a.txt": "z\n" }),
    );
    at(iso(10 * DAY), () =>
      merge({ "b.txt": "x\n" }, { "b.txt": "y\n" }, { "b.txt": "z\n" }),
    );
    expect(report([]).totals.merges).toBe(1);
    expect(report(["--days", "200"]).totals.merges).toBe(2);
    expect(report(["--all"]).totals.merges).toBe(2);
    const weeks = report(["--days", "200"]).weeks;
    expect(weeks.length).toBeGreaterThanOrEqual(28);
    expect(weeks.filter((w) => w.merges === 0).length).toBe(weeks.length - 2);
    expect(weeks.reduce((n, w) => n + w.merges, 0)).toBe(2);
    const trend = run(["--days", "200"]);
    expectSpawnExit(
      { exitCode: trend.code, stdout: trend.stdout, stderr: trend.stderr },
      0,
    );
    expect(trend.stdout).toMatch(
      /\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2} {2}no merges/,
    );
    expect(trend.stdout.match(/no merges/g)?.length ?? 0).toBeLessThanOrEqual(
      3,
    );
    const old = report([
      "--since",
      iso(120 * DAY).slice(0, 10),
      "--until",
      iso(50 * DAY).slice(0, 10),
    ]);
    expect(old.merges.map((m) => m.paths[0]?.path)).toEqual(["a.txt"]);
    expect(old.range.label).toStartWith("from ");
    const text = run([]);
    expectSpawnExit(
      { exitCode: text.code, stdout: text.stdout, stderr: text.stderr },
      0,
    );
    expect(text.stdout).toContain("the last 30 days");
    expect(text.stdout).toContain("1 merge replayed, 1 conflicted");
  });

  it("refuses a range given two ways, and an unknown argument", () => {
    for (const args of [
      ["--all", "--days", "3"],
      ["--days", "0"],
      ["--since", "yesterday"],
      ["--bogus"],
    ]) {
      const r = run(args);
      expectSpawnExit(
        { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
        2,
        args.join(" "),
      );
      expect(r.stderr).toContain("usage:");
    }
  });

  it("counts a hotspot from resolve_conflicts.hotspot_min_merges, 3 when unset", () => {
    for (let i = 0; i < 2; i++)
      merge(
        { "hot.txt": `${i}\n` },
        { "hot.txt": `o${i}\n` },
        { "hot.txt": `t${i}\n` },
      );
    expect(report().hotspots).toEqual([]);
    expect(report().hotspotMinMerges).toBe(3);
    s.overlay("resolve_conflicts:\n  hotspot_min_merges: 2\n");
    const rep = report();
    expect(rep.hotspots).toEqual(["hot.txt"]);
    expect(rep.paths[0]).toMatchObject({
      path: "hot.txt",
      merges: 2,
      hotspot: true,
      topCause: "overlap",
    });
    s.overlay("resolve_conflicts:\n  hotspot_min_merges: 0\n");
    const bad = run(["--all"]);
    expectSpawnExit(
      { exitCode: bad.code, stdout: bad.stdout, stderr: bad.stderr },
      2,
    );
    expect(bad.stderr).toContain(
      "resolve_conflicts.hotspot_min_merges must be a whole number",
    );
    // The audit's schema accepts neither: no value, and an integer past what a double holds exactly.
    for (const value of ["", " 9007199254740993"]) {
      s.overlay(`resolve_conflicts:\n  hotspot_min_merges:${value}\n`);
      const refused = run(["--all"]);
      expectSpawnExit(
        {
          exitCode: refused.code,
          stdout: refused.stdout,
          stderr: refused.stderr,
        },
        2,
      );
    }
  });

  it("emits the merge-conflicts/v1 shape", () => {
    merge({ "a.txt": "x\n" }, { "a.txt": "y\n" }, { "a.txt": "z\n" });
    const rep = report();
    expect(rep.schema).toBe("merge-conflicts/v1");
    expect(Object.keys(rep).sort()).toEqual(
      [
        "causes",
        "confidence",
        "generatedAt",
        "hotspotMinMerges",
        "hotspots",
        "limits",
        "shallow",
        "merges",
        "paths",
        "range",
        "schema",
        "skipped",
        "totals",
        "weeks",
      ].sort(),
    );
    expect(rep.range).toEqual({
      since: null,
      until: null,
      label: "all history",
    });
    expect(rep.totals).toEqual({
      merges: 1,
      conflicted: 1,
      mechanical: 0,
      paths: 1,
      regions: 1,
      skipped: 0,
    });
    expect(rep.causes).toEqual([
      expect.objectContaining({
        cause: "overlap",
        regions: 1,
        paths: 1,
        merges: 1,
      }),
    ]);
    expect(rep.weeks).toEqual([
      expect.objectContaining({
        merges: 1,
        conflicted: 1,
        causes: { overlap: 1 },
      }),
    ]);
    const m = rep.merges[0] as MergeRecord;
    expect(Object.keys(m).sort()).toEqual(
      [
        "branches",
        "commit",
        "operation",
        "conflicted",
        "date",
        "mechanical",
        "parentHeads",
        "parents",
        "paths",
        "pullRequest",
        "subject",
        "unmatchedResolutions",
      ].sort(),
    );
    expect(m.paths[0]?.regions[0]).toEqual({
      start: 1,
      end: 7,
      cause: "overlap",
      lines: { ours: 1, base: 1, theirs: 1 },
    });
    expect(rep.confidence?.causes.overlap?.checked).toBeGreaterThan(0);
    expect(rep.limits.length).toBeGreaterThan(0);
  });
});

describe("the repository is left as it was", () => {
  function state(): string {
    const objects = join(s.root, ".git", "objects");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else files.push(relative(objects, join(dir, entry.name)));
    };
    walk(objects);
    return [
      s.git("count-objects", "-v"),
      s.git("for-each-ref"),
      s.git("status", "--porcelain", "--untracked-files=all"),
      s.git("ls-files", "--stage"),
      files.sort().join("\n"),
    ].join("\n--\n");
  }

  it("changes no ref, index, working tree or object, and removes its temporary objects", () => {
    merge({ "a.txt": "x\n" }, { "a.txt": "y\n" }, { "a.txt": "z\n" });
    merge({ "b.txt": "1\n" }, { "b.txt": "2\n" }, { "b.txt": "3\n" });
    const scratchTmp = join(s.home, "tmp");
    mkdirSync(scratchTmp);
    s.env.TMPDIR = scratchTmp;
    s.env.TMP = scratchTmp;
    s.env.TEMP = scratchTmp;
    const before = state();
    expect(report().totals.conflicted).toBe(2);
    expect(state()).toBe(before);
    expect(readdirSync(scratchTmp)).toEqual([]);
  });

  it("works from a linked worktree, reading the shared objects and changing none", () => {
    merge({ "a.txt": "x\n" }, { "a.txt": "y\n" }, { "a.txt": "z\n" });
    const linked = join(s.home, "linked");
    s.git("worktree", "add", "-q", "--detach", linked);
    const before = state();
    const r = s.script("history.ts", ["--json", "--all"], linked);
    expect(state()).toBe(before);
    expectSpawnExit(
      { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
      0,
    );
    expect((JSON.parse(r.stdout) as Report).totals.conflicted).toBe(1);
  });
});

it("refuses a git older than 2.43 with a message", () => {
  const bin = join(s.home, "bin");
  mkdirSync(bin);
  writeFakeProgram(
    join(bin, "git"),
    '#!/usr/bin/env bun\nconsole.log("git version 2.42.2");\n',
  );
  s.env.PATH = `${bin}${delimiter}${s.env.PATH ?? ""}`;
  const r = run(["--all"]);
  expectSpawnExit({ exitCode: r.code, stdout: r.stdout, stderr: r.stderr }, 2);
  expect(r.stderr).toContain("needs git 2.43 or later");
});

describe("what the replay must not trust or run", () => {
  it("skips a merge whose history a shallow clone cuts, and says the report is partial", () => {
    commitAll("base", { "f.txt": "1\n2\n3\n4\n5\n" });
    s.git("checkout", "-q", "-b", "feature");
    const theirs = commitAll("feature", { "f.txt": "1\n2\n3\n4\nfive\n" });
    s.git("checkout", "-q", "main");
    commitAll("main one", { "g.txt": "g\n" });
    const ours = commitAll("main two", { "f.txt": "one\n2\n3\n4\n5\n" });
    const commit = s
      .git(
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        ours,
        "-p",
        theirs,
        "-m",
        "Merge branch 'feature'",
      )
      .trim();
    s.git("reset", "-q", "--hard", commit);
    expect(report().totals).toMatchObject({ merges: 1, conflicted: 0 });
    const clone = join(s.home, "shallow");
    const cloned = s.run(
      "git",
      ["clone", "-q", "--depth", "2", pathToFileURL(s.root).href, clone],
      s.home,
    );
    expectSpawnExit(
      { exitCode: cloned.code, stdout: cloned.stdout, stderr: cloned.stderr },
      0,
    );
    const r = s.script("history.ts", ["--json", "--all"], clone);
    expectSpawnExit(
      { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
      0,
    );
    const rep = JSON.parse(r.stdout) as Report;
    expect(rep.shallow).toBe(true);
    expect(rep.totals).toMatchObject({ merges: 0, conflicted: 0, skipped: 1 });
    expect(rep.skipped[0]).toMatchObject({ commit, reason: "shallow" });
    expect(rep.limits[0]).toContain("shallow");
    const text = s.script("history.ts", ["--all"], clone);
    expectSpawnExit(
      { exitCode: text.code, stdout: text.stdout, stderr: text.stderr },
      0,
    );
    expect(text.stdout).toContain("Partial: This clone is shallow");
    expect(text.stdout).toContain("1 skipped (listed below)");
    expect(text.stdout).toContain(`${commit.slice(0, 12)} (shallow)`);
  });

  it("runs no merge driver and reads no attribute from today's tree", () => {
    const marker = join(s.home, "driver-ran");
    s.git(
      "config",
      "merge.touchy.driver",
      `touch '${marker.replaceAll("\\", "/")}'; false`,
    );
    mkdirSync(join(s.root, ".git", "info"), { recursive: true });
    writeFileSync(
      join(s.root, ".git", "info", "attributes"),
      "*.txt merge=touchy\n",
    );
    merge(
      { "a.txt": "x\n", "notes.md": "a\n" },
      { "a.txt": "y\n", "notes.md": "a\nb\n" },
      { "a.txt": "z\n", "notes.md": "a\nc\n" },
    );
    // Today's working tree asks for a union merge, which would leave no conflict.
    s.write(".gitattributes", "*.md merge=union\n");
    const rep = report();
    expect(existsSync(marker)).toBe(false);
    expect(causesOf("notes.md", rep)).toEqual(["append"]);
    // The silenced driver leaves no markers: a text conflict with no region read is overlap.
    expect(pathOf(rep, "a.txt")).toMatchObject({
      causes: ["overlap"],
      regions: [],
      mechanical: false,
    });
  });

  it("reads regions at the marker size $GIT_DIR/info/attributes sets", () => {
    mkdirSync(join(s.root, ".git", "info"), { recursive: true });
    writeFileSync(
      join(s.root, ".git", "info", "attributes"),
      "*.md conflict-marker-size=12\n",
    );
    merge(
      { "notes.md": "a\n" },
      { "notes.md": "a\nb\n" },
      { "notes.md": "a\nc\n" },
    );
    const rep = report();
    expect(pathOf(rep, "notes.md")).toMatchObject({
      causes: ["append"],
      mechanical: true,
    });
    expect(causesOf("notes.md", rep)).toEqual(["append"]);
  });

  it("reads merges whose signature git would show (log.showSignature)", () => {
    const bin = join(s.home, "bin-gpg");
    mkdirSync(bin);
    writeFakeProgram(
      join(bin, "gpg"),
      [
        "#!/usr/bin/env bun",
        'if (process.argv.includes("--verify")) {',
        '  process.stderr.write("gpg: Good signature from a fake\\n");',
        '  process.stdout.write("[GNUPG:] GOODSIG 0 fake\\n[GNUPG:] VALIDSIG 0\\n[GNUPG:] TRUST_ULTIMATE\\n");',
        "} else {",
        "  await Bun.stdin.text();",
        '  process.stderr.write("[GNUPG:] SIG_CREATED \\n");',
        '  process.stdout.write("-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n");',
        "}",
        "",
      ].join("\n"),
    );
    s.git("config", "gpg.program", join(bin, "gpg"));
    s.git("config", "log.showSignature", "true");
    const { commit } = merge(
      { "a.txt": "x\n" },
      { "a.txt": "y\n" },
      { "a.txt": "z\n" },
    );
    const signed = s
      .git(
        "commit-tree",
        "-S",
        `${commit}^{tree}`,
        "-p",
        `${commit}^1`,
        "-p",
        `${commit}^2`,
        "-m",
        "Merge branch 'signed'",
      )
      .trim();
    s.git("reset", "-q", "--hard", signed);
    expect(s.git("log", "-1").toLowerCase()).toContain("good signature");
    const rep = report();
    expect(rep.skipped).toEqual([]);
    expect(rep.merges.map((m) => m.commit)).toEqual([signed]);
    expect(rep.merges[0]?.conflicted).toBe(true);
  });

  it("refuses a partial clone when git cannot be kept from fetching", () => {
    merge({ "a.txt": "x\n" }, { "a.txt": "y\n" }, { "a.txt": "z\n" });
    const real = Bun.which("git", { PATH: s.env.PATH ?? "" }) as string;
    const fake = (version: string) => {
      const bin = join(s.home, `bin-${version}`);
      mkdirSync(bin);
      writeFakeProgram(
        join(bin, "git"),
        [
          "#!/usr/bin/env bun",
          "const args = process.argv.slice(2);",
          `if (args.includes("--version")) { console.log("git version ${version}"); process.exit(0); }`,
          `const r = Bun.spawnSync([${JSON.stringify(real)}, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });`,
          "process.exit(r.exitCode ?? 1);",
          "",
        ].join("\n"),
      );
      return bin;
    };
    const path = s.env.PATH ?? "";
    const config = join(s.root, ".git", "config");
    const plain = readFileSync(config, "utf8");
    s.env.PATH = `${fake("2.44.0")}${delimiter}${path}`;
    // A promisor set true, set with no value (true to git), or a filter alone.
    for (const remote of [
      "\tpromisor = true\n",
      "\tpromisor\n",
      "\tpartialclonefilter = blob:none\n",
    ]) {
      writeFileSync(config, `${plain}[remote "origin"]\n${remote}`);
      const old = run(["--all"]);
      expectSpawnExit(
        { exitCode: old.code, stdout: old.stdout, stderr: old.stderr },
        2,
      );
      expect(old.stderr).toContain("partial clone");
    }
    s.env.PATH = `${fake("2.45.0")}${delimiter}${path}`;
    const recent = run(["--json", "--all"]);
    expectSpawnExit(
      { exitCode: recent.code, stdout: recent.stdout, stderr: recent.stderr },
      0,
    );
  });

  it("skips a merge it cannot replay and replays the rest", () => {
    const broken = merge(
      { "a.txt": "x\n" },
      { "a.txt": "y\n" },
      { "a.txt": "z\n" },
    );
    merge({ "b.txt": "1\n" }, { "b.txt": "2\n" }, { "b.txt": "3\n" });
    const blob = s.git("rev-parse", `${broken.parentsAre[1]}:a.txt`).trim();
    rmSync(join(s.root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const rep = report();
    expect(rep.totals).toMatchObject({ merges: 1, skipped: 1 });
    expect(rep.skipped[0]).toMatchObject({
      commit: broken.commit,
      reason: "replay-failed",
    });
  });

  it("reads paths holding a space or a newline", () => {
    const git = (args: string[], input?: string) => {
      const r = spawnSync("git", args, {
        cwd: s.root,
        env: s.env,
        input: input ?? "",
      });
      expectSpawnExit(
        { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
        0,
        args.join(" "),
      );
      return r.stdout.trim();
    };
    const tree = (files: Record<string, string>) =>
      git(
        ["mktree", "-z"],
        Object.entries(files)
          .map(
            ([path, text]) =>
              `100644 blob ${git(["hash-object", "-w", "--stdin"], text)}\t${path}\0`,
          )
          .join(""),
      );
    const odd = ["a b.txt", "new\nline.txt"];
    const side = (text: string) =>
      tree(Object.fromEntries(odd.map((p) => [p, text])));
    const base = git(["commit-tree", side("x\n"), "-m", "base"]);
    const ours = git(["commit-tree", side("y\n"), "-p", base, "-m", "ours"]);
    const theirs = git([
      "commit-tree",
      side("z\n"),
      "-p",
      base,
      "-m",
      "theirs",
    ]);
    const commit = git([
      "commit-tree",
      side("y\n"),
      "-p",
      ours,
      "-p",
      theirs,
      "-m",
      "odd",
    ]);
    git(["update-ref", "refs/heads/odd", commit]);
    const rep = report();
    for (const path of odd) {
      expect(causesOf(path, rep)).toEqual(["overlap"]);
      expect(pathOf(rep, path).regions).toHaveLength(1);
    }
  });
});
