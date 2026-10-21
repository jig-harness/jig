// The units, the configuration and the live decision are tested directly; the
// diff modes and exit codes run the gate in throwaway git repositories.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  addedLines,
  type Config,
  DEFAULT_MARKERS,
  liveFindings,
  parseConfig,
  parseStates,
  readDocument,
  run as check,
  units,
} from "./check-deferrals";

const script = join(import.meta.dir, "check-deferrals.ts");
const scratch = mkdtempSync(join(tmpdir(), "jig-deferrals-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A git hook exports GIT_DIR and friends pointing at the real repository; a
// scratch repository's git calls must not inherit them.
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
Object.assign(env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});
delete env.DIFF_RANGE;

const CONFIG = `items:
  - '\\b[A-Z][A-Z0-9]{1,9}-\\d+\\b'
exclude:
  - 'docs/archive/**'
`;
const config: Config = parseConfig(CONFIG, "test.yaml");

const findingsOf = (content: string, c = config) =>
  readDocument(content, c).findings.map((f) => `${f.line}:${f.rule}`);
const keysOf = (content: string, c = config) =>
  readDocument(content, c).deferrals.map((d) => d.keys);

describe("configuration", () => {
  test("defaults: every Markdown file, the default markers, nothing excluded", () => {
    const c = parseConfig("items: ['X-\\d+']\n", "c.yaml");
    expect(c.include).toEqual(["**/*.md"]);
    expect(c.exclude).toEqual([]);
    expect(c.markers).toHaveLength(DEFAULT_MARKERS.length);
  });

  test.each([
    ["no items", "include: ['**/*.md']\n", "items must list at least one"],
    ["empty items", "items: []\n", "items must list at least one"],
    ["a pattern that does not compile", "items: ['(']\n", "does not compile"],
    ["a pattern matching nothing at all", "items: ['X*']\n", "empty string"],
    [
      "an unknown key",
      "items: ['X-\\d+']\nmarker: [a]\n",
      "unknown key marker",
    ],
    ["a wrong version", "version: 2\nitems: ['X-\\d+']\n", "version must be 1"],
    [
      "a blank marker",
      "items: ['X-\\d+']\nmarkers: ['']\n",
      "non-empty strings",
    ],
    ["a scalar for a list", "items: 'X-\\d+'\n", "list of non-empty strings"],
    [
      "an empty marker list",
      "items: ['X-\\d+']\nmarkers: []\n",
      "markers must list at least one",
    ],
    [
      "an empty include list",
      "items: ['X-\\d+']\ninclude: []\n",
      "include must list at least one",
    ],
    ["a list at the top", "- a\n", "must be a mapping"],
    ["YAML that does not parse", "items: [\n", "not readable YAML"],
  ])("%s is refused", (_name, text, message) => {
    expect(() => parseConfig(text, "c.yaml")).toThrow(message);
  });
});

describe("units", () => {
  test("paragraphs, list items with continuations, table rows and headings are separate blocks", () => {
    const doc = [
      "# Title with a heading",
      "",
      "First line",
      "second line.",
      "",
      "- item one",
      "  continued",
      "- item two",
      "  - nested",
      "",
      "| a | b |",
      "|---|---|",
      "| c | d |",
    ].join("\n");
    expect(units(doc).map((u) => [u.start, u.end])).toEqual([
      [1, 1],
      [3, 4],
      [6, 7],
      [8, 8],
      [9, 9],
      [11, 11],
      [12, 12],
      [13, 13],
    ]);
  });

  test("frontmatter and fenced code are not prose", () => {
    const doc = [
      "---",
      "title: tracked to closure",
      "---",
      "",
      "```",
      "tracked to closure",
      "```",
      "",
      "~~~~",
      "```",
      "will be filed",
      "~~~~",
      "",
      "after",
    ].join("\n");
    expect(units(doc).map((u) => u.text)).toEqual(["after"]);
    expect(findingsOf(doc)).toEqual([]);
  });

  test("a fence inside a nested list item is code, however deep it is indented", () => {
    const doc = [
      "- a",
      "  - b",
      "",
      "        ```",
      "        will be filed",
      "        ENG-5",
      "        ```",
      "",
      "  - c, tracked to closure.",
    ].join("\n");
    expect(findingsOf(doc)).toEqual(["9:deferral-names-no-item"]);
    expect(keysOf(doc)).toEqual([[]]);
  });

  test("a loose list item keeps its indented later paragraph, a flush paragraph is its own block", () => {
    const doc = [
      "- Audit the log.",
      "",
      "  Tracked to closure under ENG-7.",
      "",
      "Not part of it.",
    ].join("\n");
    expect(units(doc).map((u) => [u.start, u.end])).toEqual([
      [1, 3],
      [5, 5],
    ]);
    expect(keysOf(doc)).toEqual([["ENG-7"]]);
  });

  test("block quotes are read like the text inside them", () => {
    expect(findingsOf("> A follow-up will be filed.\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
  });

  test("a closing fence is the fence run alone; a longer line is still code", () => {
    const doc = [
      "```",
      "```still-code",
      "will be filed",
      "```",
      "",
      "after",
    ].join("\n");
    expect(units(doc).map((u) => u.text)).toEqual(["after"]);
  });

  test("a table without outer pipes keeps each row its own block", () => {
    const doc = [
      "Risk | Tracking",
      "--- | ---",
      "A | tracked to closure",
      "B | ENG-1",
    ].join("\n");
    expect(units(doc).map((u) => [u.start, u.end])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
    expect(findingsOf(doc)).toEqual(["3:deferral-names-no-item"]);
  });

  test("entering or leaving a block quote ends the block", () => {
    expect(findingsOf("Tracked to closure.\n> ENG-1\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
    expect(findingsOf("> Tracked to closure.\nENG-1\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
    expect(findingsOf("> Tracked to closure\n> under ENG-1.\n")).toEqual([]);
  });

  test("a paragraph after a nested item belongs to the item its indent reaches", () => {
    const doc = ["- Tracked to closure.", "  - Context.", "", "  ENG-1"].join(
      "\n",
    );
    expect(findingsOf(doc)).toEqual([]);
    expect(keysOf(doc)).toEqual([["ENG-1"]]);
    const deeper = [
      "- Outer.",
      "  - Tracked to closure.",
      "",
      "    ENG-2",
    ].join("\n");
    expect(keysOf(deeper)).toEqual([["ENG-2"]]);
  });

  test("an HTML comment is blanked across lines and blocks before blocks are built", () => {
    expect(findingsOf("Tracked to closure.\n<!--\nENG-1\n\n-->\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
    expect(
      findingsOf("Tracked to closure <!-- a\nnote --> under ENG-1.\n"),
    ).toEqual([]);
    expect(findingsOf("<!-- note -->\nTracked to closure.\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
  });

  test("an empty document and a document of only a rule have no blocks", () => {
    expect(units("")).toEqual([]);
    expect(units("---\n")).toEqual([]);
  });
});

describe("the static half", () => {
  test("a marker with no item is a finding at the block's first line", () => {
    const doc = "# T\n\nThe gap is tracked to closure.\nSecond line.\n";
    expect(findingsOf(doc)).toEqual(["3:deferral-names-no-item"]);
  });

  test("a marker with an item in the same block passes, in a paragraph, a list item and a table row", () => {
    const doc = [
      "Tracked to closure under ENG-12.",
      "",
      "- A follow-up will be filed",
      "  (ENG-13).",
      "",
      "| Risk | Tracking |",
      "|---|---|",
      "| R-1 | tracked to closure, ENG-14 |",
    ].join("\n");
    expect(findingsOf(doc)).toEqual([]);
    expect(keysOf(doc)).toEqual([["ENG-12"], ["ENG-13"], ["ENG-14"]]);
  });

  test("an item in the next block does not name this block's deferral", () => {
    expect(findingsOf("Tracked to closure.\n\nSee ENG-12.\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
  });

  test("markers match case-insensitively, across emphasis and line breaks, on word edges only", () => {
    const hit = (text: string) => findingsOf(`${text}\n`).length;
    expect(hit("TRACKED TO CLOSURE")).toBe(1);
    expect(hit("tracked to **closure**")).toBe(1);
    expect(hit("tracked\nto   closure")).toBe(1);
    expect(hit("the issue was filed")).toBe(0);
    expect(hit("it will be filed.")).toBe(1);
    expect(hit("a runwill be filed")).toBe(0);
    expect(hit("will be filedx")).toBe(0);
  });

  test("markers are the configured ones", () => {
    const c = parseConfig(
      "items: ['X-\\d+']\nmarkers: ['to be scheduled']\n",
      "c.yaml",
    );
    expect(findingsOf("Work to be scheduled.\n", c)).toEqual([
      "1:deferral-names-no-item",
    ]);
    expect(findingsOf("Tracked to closure.\n", c)).toEqual([]);
  });

  test("an item pattern with a group names the key by the group", () => {
    const c = parseConfig(
      "items: ['https://tracker\\.example/issue/(\\d+)']\n",
      "c.yaml",
    );
    expect(
      keysOf("Tracked to closure: https://tracker.example/issue/42\n", c),
    ).toEqual([["42"]]);
  });

  test("a string that only looks like an item is not one when the pattern is the team's", () => {
    const c = parseConfig("items: ['\\bENG-\\d+\\b']\n", "c.yaml");
    expect(findingsOf("Tracked to closure under ADR-0036.\n", c)).toEqual([
      "1:deferral-names-no-item",
    ]);
  });

  test("an item pattern is matched against the text as written, then without emphasis marks", () => {
    const c = parseConfig(
      "items: ['https://t\\.example/my_team/(\\d+)', '\\bENG-\\d+\\b']\n",
      "c.yaml",
    );
    expect(
      keysOf("Will be filed at https://t.example/my_team/42\n", c),
    ).toEqual([["42"]]);
    expect(keysOf("Will be filed: _ENG-5_ and **ENG-6**\n", c)).toEqual([
      ["ENG-5", "ENG-6"],
    ]);
  });

  test.each([
    ["a lookahead", "items: ['(?=ENG)']\n", "Tracked to closure ENG\n"],
    ["an empty group", "items: ['ENG-(\\d*)']\n", "Tracked to closure ENG-\n"],
    [
      "an optional group that took no part",
      "items: ['ENG-(\\d+)?']\n",
      "Tracked to closure under ENG-\n",
    ],
  ])(
    "a pattern matching nothing in the text (%s) names no item",
    (_n, c, doc) => {
      expect(findingsOf(doc, parseConfig(c, "c.yaml"))).toEqual([
        "1:deferral-names-no-item",
      ]);
    },
  );

  test("an item hidden in an HTML comment names nothing", () => {
    expect(findingsOf("Tracked to closure <!-- ENG-12 -->\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
  });

  test("a waiver with a reason sets the block aside, in both halves", () => {
    const doc =
      "How to word a deferral: say it is tracked to closure. <!-- deferral-ok: explains the rule -->\n";
    expect(findingsOf(doc)).toEqual([]);
    expect(readDocument(doc, config).deferrals).toEqual([]);
  });

  test.each([
    "<!-- deferral-ok -->",
    "<!-- deferral-ok: -->",
    "<!-- deferral-ok:   -->",
  ])("a waiver with no reason is a finding: %s", (waiver) => {
    expect(findingsOf(`Tracked to closure. ${waiver}\n`)).toEqual([
      "1:deferral-waiver-without-reason",
    ]);
  });

  test("every waiver in a block needs a reason, not only one of them", () => {
    expect(
      findingsOf(
        "Tracked to closure. <!-- deferral-ok: x --> <!-- deferral-ok -->\n",
      ),
    ).toEqual(["1:deferral-waiver-without-reason"]);
  });

  test.each(["<!-- deferral-ok-ignore -->", "<!-- deferral-okay: x -->"])(
    "a comment that is not the waiver token waives nothing: %s",
    (comment) => {
      expect(findingsOf(`Tracked to closure. ${comment}\n`)).toEqual([
        "1:deferral-names-no-item",
      ]);
    },
  );

  test("a waiver on its own line after the block, or spanning lines, still waives it", () => {
    expect(
      findingsOf("Tracked to closure.\n<!-- deferral-ok: example -->\n"),
    ).toEqual([]);
    expect(
      findingsOf(
        "Tracked to closure. <!-- deferral-ok:\nexplains the rule -->\n",
      ),
    ).toEqual([]);
  });

  test("a deferral beside a waived one is still judged", () => {
    const doc =
      "Tracked to closure. <!-- deferral-ok: example -->\n\nTracked to closure.\n";
    expect(findingsOf(doc)).toEqual(["3:deferral-names-no-item"]);
  });
});

describe("the live half", () => {
  const deferrals = (text: string) => readDocument(text, config).deferrals;
  const states = (o: Record<string, string>) =>
    parseStates(JSON.stringify(o), "s.json");

  test("fails when every item named is closed, and says which and why", () => {
    const [f] = liveFindings(
      deferrals("Tracked to closure under ENG-1 and ENG-2.\n"),
      states({ "ENG-1": "closed", "ENG-2": "not_found" }),
    );
    expect(f?.rule).toBe("deferral-relies-on-closed-item");
    expect(f?.problem).toContain("ENG-1 (closed), ENG-2 (does not exist)");
  });

  test("passes while one item named is still open: a closed item beside it is provenance", () => {
    expect(
      liveFindings(
        deferrals("Tracked to closure under ENG-2. Origin: ENG-1.\n"),
        states({ "ENG-1": "closed", "ENG-2": "open" }),
      ),
    ).toEqual([]);
  });

  test("a deferral naming no item is the static half's, not a live finding", () => {
    expect(
      liveFindings(deferrals("Tracked to closure.\n"), states({})),
    ).toEqual([]);
  });

  test("an item the provider did not answer for is an error, not a pass", () => {
    expect(() =>
      liveFindings(
        deferrals("Tracked to closure under ENG-1.\n"),
        states({ "ENG-9": "open" }),
      ),
    ).toThrow("no state for ENG-1");
  });

  test.each([
    ["not JSON", "{", "not JSON"],
    ["an array", "[]", "must be a JSON object"],
    ["a null", "null", "must be a JSON object"],
    [
      "a state this gate does not know",
      '{"ENG-1":"started"}',
      "not one of open, closed, not_found",
    ],
    ["a non-string state", '{"ENG-1":true}', "not one of"],
  ])("a state file that is %s is refused", (_name, text, message) => {
    expect(() => parseStates(text, "s.json")).toThrow(message);
  });
});

describe("added lines", () => {
  test("additions, a changed range and a pure deletion mark the lines they touch", () => {
    const diff = ["@@ -1,0 +2 @@", "@@ -5,2 +6,3 @@", "@@ -9,2 +11,0 @@"].join(
      "\n",
    );
    expect([...addedLines(diff)].sort((a, b) => a - b)).toEqual([
      2, 6, 7, 8, 11, 12,
    ]);
  });

  test("given the content, a deletion reaches the nearest non-blank line either side", () => {
    const content = "- Tracked to closure.\n\n\nNext.\n";
    expect([...addedLines("@@ -3 +2,0 @@", content)].sort()).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

// ── Whole-command runs in throwaway repositories ──────────────────────────

let counter = 0;
function repo(files: Record<string, string>, configText = CONFIG) {
  const dir = join(scratch, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0, `git ${args.join(" ")}`);
    return r.stdout.toString();
  };
  const write = (name: string, text: string) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  git("init", "-q", "-b", "main");
  write(".config/deferral-references.yaml", configText);
  for (const [name, text] of Object.entries(files)) write(name, text);
  git("add", ".");
  git("commit", "-qm", "initial");
  // In-process: the command line is read the way the script reads it, without
  // a bun start-up per case. `spawn` runs the real entry point.
  const run = (
    args: string[],
    extra: Record<string, string> = {},
    cwd = dir,
  ) => {
    const out: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => out.push(parts.join(" "));
    try {
      const exitCode = check(args, { ...env, ...extra }, cwd);
      return { exitCode, stdout: `${out.join("\n")}\n`, stderr: "" };
    } catch (error) {
      return { exitCode: 2, stdout: out.join("\n"), stderr: String(error) };
    } finally {
      console.log = log;
    }
  };
  const spawn = (args: string[], cwd = dir) => {
    const r = Bun.spawnSync(["bun", script, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  };
  return { dir, git, write, run, spawn };
}

describe("--all", () => {
  test("judges every document in scope and leaves the excluded ones", () => {
    const r = repo({
      "docs/a.md": "Tracked to closure.\n",
      "docs/b.md": "Tracked to closure under ENG-1.\n",
      "docs/archive/old.md": "Tracked to closure.\n",
      "notes.txt": "Tracked to closure.\n",
    });
    const result = r.run(["--all"]);
    expectSpawnExit(result, 1);
    expect(result.stdout).toContain("docs/a.md:1: [deferral-names-no-item]");
    expect(result.stdout).not.toContain("old.md");
    expect(result.stdout).not.toContain("notes.txt");
    expect(result.stdout).toContain(
      "2 document(s), 2 deferral(s), 1 finding(s)",
    );
  });

  test("passes a tree whose deferrals all name an item", () => {
    const r = repo({ "a.md": "Tracked to closure under ENG-1.\n" });
    expectSpawnExit(r.run(["--all"]), 0);
  });

  test("a nested repository directory is judged from the repository root", () => {
    const r = repo({ "docs/a.md": "Tracked to closure.\n" });
    const result = r.run(["--all"], {}, join(r.dir, "docs"));
    expectSpawnExit(result, 1);
  });
});

describe("--staged", () => {
  test("judges a block the commit adds, not an old one it leaves alone", () => {
    const r = repo({ "a.md": "Old: tracked to closure.\n\nOther text.\n" });
    r.write("a.md", "Old: tracked to closure.\n\nOther text, edited.\n");
    r.git("add", ".");
    expectSpawnExit(r.run(["--staged"]), 0);
    r.write(
      "a.md",
      "Old: tracked to closure.\n\nOther text, edited.\n\nNew: tracked to closure.\n",
    );
    r.git("add", ".");
    const result = r.run(["--staged"]);
    expectSpawnExit(result, 1);
    expect(result.stdout).toContain("a.md:5:");
    expect(result.stdout).not.toContain("a.md:1:");
  });

  test("an edit inside an old deferral block brings that block under the gate", () => {
    const r = repo({ "a.md": "Tracked to closure under ENG-1\nand more.\n" });
    r.write("a.md", "Tracked to closure\nand more words.\n");
    r.git("add", ".");
    expectSpawnExit(r.run(["--staged"]), 1);
  });

  test("deleting the line that named the item exposes the deferral", () => {
    const r = repo({ "a.md": "Tracked to closure\nunder ENG-1.\n" });
    r.write("a.md", "Tracked to closure\n");
    r.git("add", ".");
    expectSpawnExit(r.run(["--staged"]), 1);
  });

  test("a change to the configuration judges every document, not only the changed ones", () => {
    const r = repo(
      { "a.md": "Tracked to closure under TASK-1.\n" },
      "items: ['\\bENG-\\d+\\b']\n",
    );
    expectSpawnExit(r.run(["--all"]), 1);
    r.write(".config/deferral-references.yaml", "items: ['\\bTASK-\\d+\\b']\n");
    r.git("add", ".");
    expectSpawnExit(r.run(["--staged"]), 0);
    r.git("commit", "-qm", "narrow items");
    r.write(
      ".config/deferral-references.yaml",
      "items: ['\\bOTHER-\\d+\\b']\n",
    );
    r.git("add", ".");
    expectSpawnExit(r.run(["--staged"]), 1);
    r.git("commit", "-qm", "change items");
    expectSpawnExit(r.run(["--range=HEAD~1...HEAD"]), 1);
  });

  test("deleting the item's paragraph in a loose list item exposes the deferral", () => {
    const r = repo({ "a.md": "- Tracked to closure.\n\n  ENG-1.\n" });
    r.write("a.md", "- Tracked to closure.\n\n");
    r.git("add", ".");
    expectSpawnExit(r.run(["--staged"]), 1);
  });

  test("reads the configuration and every document from the index when the configuration is staged", () => {
    const r = repo(
      { "a.md": "Fine.\n", "b.md": "Fine.\n" },
      "items: ['\\bENG-\\d+\\b']\n",
    );
    r.write("a.md", "Tracked to closure.\n");
    r.write(".config/deferral-references.yaml", "items: ['\\bTASK-\\d+\\b']\n");
    r.git("add", ".");
    // The item arrives only in the working tree; the commit lacks it.
    r.write("a.md", "Tracked to closure under TASK-1.\n");
    expectSpawnExit(r.run(["--staged"]), 1);
  });

  test("an unstaged configuration does not judge the staged change", () => {
    const r = repo({ "a.md": "Fine.\n" }, "items: ['\\bENG-\\d+\\b']\n");
    r.write("a.md", "Tracked to closure under TASK-1.\n");
    r.git("add", "a.md");
    r.write(".config/deferral-references.yaml", "items: ['\\bTASK-\\d+\\b']\n");
    expectSpawnExit(r.run(["--staged"]), 1);
  });

  test("blanking the reason on a later line of a multi-line waiver brings the block under the gate", () => {
    const r = repo({
      "a.md": "Tracked to closure. <!-- deferral-ok:\nexplains the rule\n-->\n",
    });
    r.write("a.md", "Tracked to closure. <!-- deferral-ok:\n  \n-->\n");
    r.git("add", ".");
    const result = r.run(["--staged"]);
    expectSpawnExit(result, 1);
    expect(result.stdout).toContain("deferral-waiver-without-reason");
  });

  test("a staged configuration deleted from the working tree is read from the index", () => {
    const r = repo({ "a.md": "Fine.\n" }, "items: ['\\bENG-\\d+\\b']\n");
    r.write("a.md", "Tracked to closure.\n");
    r.git("add", ".");
    rmSync(join(r.dir, ".config/deferral-references.yaml"));
    expectSpawnExit(r.run(["--staged"]), 1);
  });

  test("is the default with no mode given", () => {
    const r = repo({ "a.md": "Fine.\n" });
    r.write("a.md", "Tracked to closure.\n");
    r.git("add", ".");
    expectSpawnExit(r.run([]), 1);
  });

  test("reads the staged blob, not later unstaged edits", () => {
    const r = repo({ "a.md": "Fine.\n" });
    r.write("a.md", "Tracked to closure under ENG-1.\n");
    r.git("add", ".");
    r.write("a.md", "Tracked to closure.\n");
    expectSpawnExit(r.run(["--staged"]), 0);
  });

  test("a document outside the scope is not judged", () => {
    const r = repo({ "docs/archive/a.md": "Fine.\n" });
    r.write("docs/archive/a.md", "Tracked to closure.\n");
    r.git("add", ".");
    expectSpawnExit(r.run(["--staged"]), 0);
  });
});

describe("--range and DIFF_RANGE", () => {
  function branch() {
    const r = repo({ "a.md": "Old: tracked to closure.\n" });
    r.git("checkout", "-q", "-b", "feature");
    r.write("b.md", "New: tracked to closure.\n");
    r.git("add", ".");
    r.git("commit", "-qm", "feature");
    // main moves on, so the merge base differs from main's tip.
    r.git("checkout", "-q", "main");
    r.write("c.md", "Main: tracked to closure.\n");
    r.git("add", ".");
    r.git("commit", "-qm", "main moves");
    r.git("checkout", "-q", "feature");
    return r;
  }

  test("A...B judges what the branch adds since the merge base", () => {
    const r = branch();
    const result = r.run(["--range=main...HEAD"]);
    expectSpawnExit(result, 1);
    expect(result.stdout).toContain("b.md:1:");
    expect(result.stdout).not.toContain("a.md");
    expect(result.stdout).not.toContain("c.md");
  });

  test("DIFF_RANGE is read when --range is not given, and --range wins", () => {
    const r = branch();
    expectSpawnExit(r.run([], { DIFF_RANGE: "main...HEAD" }), 1);
    expectSpawnExit(
      r.run(["--range=HEAD...HEAD"], { DIFF_RANGE: "main...HEAD" }),
      0,
    );
  });

  test("a single ref compares with that commit", () => {
    const r = branch();
    expectSpawnExit(r.run(["--range=main"]), 1);
  });

  test.each([
    "...HEAD",
    "..HEAD",
    "main...",
    "a...b...c",
    "HEAD..nope",
    "main..nope",
  ])(
    "the malformed or unresolvable range %p is could-not-check, with and without --ci",
    (range) => {
      const r = branch();
      for (const extra of [[], ["--ci"]]) {
        const result = r.run([`--range=${range}`, ...extra]);
        expectSpawnExit(result, 2, range);
      }
    },
  );

  test("a ref that does not resolve is could-not-check", () => {
    const r = branch();
    const result = r.run(["--range=nope...HEAD"]);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("nope");
  });

  test("--ci with no range says it skipped and passes", () => {
    const r = branch();
    const result = r.run(["--ci"]);
    expectSpawnExit(result, 0);
    expect(result.stdout).toContain("SKIP");
  });
});

describe("could not check", () => {
  test("a missing configuration names the template", () => {
    const r = repo({ "a.md": "Fine.\n" });
    const result = r.run(["--all", "--config", "missing.yaml"]);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("missing.yaml");
  });

  test("a broken configuration is could-not-check, never a pass", () => {
    const r = repo({ "a.md": "Tracked to closure.\n" }, "items: [\n");
    expectSpawnExit(r.run(["--all"]), 2);
  });

  test.each([
    [["--all", "--staged"]],
    [["--all", "--range=main"]],
    [["--staged", "--range=main"]],
    [["--list-keys"]],
    [["--states", "s.json"]],
    [["--all", "--list-keys", "--states", "s.json"]],
    [["--nope"]],
    [["a.md"]],
  ])("the arguments %p are a usage error", (args) => {
    const r = repo({ "a.md": "Fine.\n" });
    expectSpawnExit(r.run(args), 2, args.join(" "));
  });

  test("outside a git repository", () => {
    const dir = mkdtempSync(join(scratch, "bare-"));
    const result = repo({}).run(["--all"], {}, dir);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("not inside a git repository");
  });
});

describe("the entry point", () => {
  test("exits 0 clean, 1 on a finding and 2 when it could not check, findings on stdout", () => {
    const r = repo({ "a.md": "Tracked to closure under ENG-1.\n" });
    expectSpawnExit(r.spawn(["--all"]), 0);
    r.write("a.md", "Tracked to closure.\n");
    const finding = r.spawn(["--all"]);
    expectSpawnExit(finding, 1);
    expect(finding.stdout).toContain("[deferral-names-no-item]");
    const unusable = r.spawn(["--all", "--staged"]);
    expectSpawnExit(unusable, 2);
    expect(unusable.stderr).toContain("ERROR:");
  });

  test("DIFF_RANGE in the environment names the diff", () => {
    const r = repo({ "a.md": "Fine.\n" });
    r.write("a.md", "Tracked to closure.\n");
    r.git("commit", "-qam", "promise");
    const spawned = Bun.spawnSync(["bun", script], {
      cwd: r.dir,
      env: { ...env, DIFF_RANGE: "HEAD~1...HEAD" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(spawned, 1);
  });
});

describe("the live half through the command", () => {
  const docs = {
    "a.md": "Tracked to closure under ENG-1.\n",
    "b.md":
      "Will be filed under ENG-2, origin ENG-3.\n\nNot a deferral: ENG-4 is mentioned.\n",
    "c.md": "Tracked to closure. <!-- deferral-ok: explains the rule -->\n",
  };

  test("--list-keys prints the items deferrals rely on, once each, sorted", () => {
    const r = repo(docs);
    const result = r.run(["--all", "--list-keys"]);
    expectSpawnExit(result, 0);
    expect(result.stdout).toBe("ENG-1\nENG-2\nENG-3\n");
  });

  test("--states fails the deferral whose items are all closed and names the file", () => {
    const r = repo(docs);
    r.write(
      "states.json",
      JSON.stringify({ "ENG-1": "closed", "ENG-2": "open", "ENG-3": "closed" }),
    );
    const result = r.run(["--all", "--states", "states.json"]);
    expectSpawnExit(result, 1);
    expect(result.stdout).toContain("a.md:1: [deferral-relies-on-closed-item]");
    expect(result.stdout).not.toContain("b.md");
  });

  test("--states passes when every deferral still has an open item", () => {
    const r = repo(docs);
    r.write(
      "states.json",
      JSON.stringify({ "ENG-1": "open", "ENG-2": "open", "ENG-3": "closed" }),
    );
    expectSpawnExit(r.run(["--all", "--states", "states.json"]), 0);
  });

  test("--states with an item missing from the file is could-not-check", () => {
    const r = repo(docs);
    r.write("states.json", JSON.stringify({ "ENG-1": "open" }));
    const result = r.run(["--all", "--states", "states.json"]);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("ENG-2");
  });

  test("--states also reports a deferral that names no item, which has nothing to look up", () => {
    const r = repo({ ...docs, "d.md": "Tracked to closure.\n" });
    r.write(
      "states.json",
      JSON.stringify({ "ENG-1": "open", "ENG-2": "open", "ENG-3": "open" }),
    );
    const result = r.run(["--all", "--states", "states.json"]);
    expectSpawnExit(result, 1);
    expect(result.stdout).toContain("d.md:1: [deferral-names-no-item]");
  });

  test.each([["--states"], ["--config"]])(
    "%s naming a file outside the repository is refused, unread",
    (flag) => {
      const r = repo(docs);
      r.write("../outside.json", "{}");
      const result = r.run(["--all", flag, "../outside.json"]);
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain("lies outside the repository");
    },
  );

  test("--states with an unreadable file is could-not-check", () => {
    const r = repo(docs);
    expectSpawnExit(r.run(["--all", "--states", "nope.json"]), 2);
  });
});
