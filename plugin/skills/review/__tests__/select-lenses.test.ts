import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  cleanupFixtures,
  fixture,
  review,
  run,
  setup,
} from "./review-fixture.ts";

setDefaultTimeout(60000);
afterEach(cleanupFixtures);

const script = resolve(import.meta.dir, "../scripts/select-lenses.ts");
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A base snapshot: its configuration and files, each path to its content. */
function base(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "lens base "));
  scratch.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** A diff that adds `lines` to `path`, as git writes one against nothing. */
function added(path: string, ...lines: string[]): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}\n`).join("")}`;
}

function removed(path: string, ...lines: string[]): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -3,${lines.length} +2,0 @@\n${lines.map((l) => `-${l}\n`).join("")}`;
}

function select(
  root: string,
  files: string[],
  diff: string,
  ...flags: string[]
) {
  const dir = mkdtempSync(join(tmpdir(), "lens input "));
  scratch.push(dir);
  writeFileSync(join(dir, "files"), files.map((f) => `${f}\0`).join(""));
  writeFileSync(join(dir, "diff"), diff);
  return run(
    root,
    process.execPath,
    [script, join(dir, "files"), join(dir, "diff"), ...flags],
    {
      ...process.env,
      JIG_CONSUMER_ROOT: root,
      JIG_OVERLAY: join(root, ".config/jig.yaml"),
      JIG_USER_LAYER: "off",
    },
  );
}

interface Result {
  id: string | null;
  version: number | null;
  source: string;
  file: string;
  runs: boolean;
  reason: string;
  match?: Record<string, unknown>;
}

function selected(
  root: string,
  files: string[],
  diff: string,
  ...flags: string[]
): Result[] {
  const result = select(root, files, diff, "--json", ...flags);
  expectSpawnExit(result, 0);
  return (JSON.parse(result.stdout) as { lenses: Result[] }).lenses;
}

function lens(
  results: Result[],
  id: string | null,
  file?: string,
): Result | undefined {
  return results.find(
    (r) => r.id === id && (file === undefined || r.file.endsWith(file)),
  );
}

const LENS_DIR = ".config/review-lenses";
function repositoryLens(id: string, extra = ""): string {
  return `---\nid: ${id}\nversion: 2\nrules: []\nlever: L-0007\ntrigger:\n  paths: ["docs/**"]\n${extra}evidence: quoted-claim\n---\n\n## Look for\n\n## Not a finding\n\n## Evidence\n`;
}

test("a diff that adds a catch selects the swallowed-failure lens, and a docs-only diff skips it, each with its reason", () => {
  const root = fixture();
  writeFileSync(
    join(root, "kept.ts"),
    "base\ntry { work(); } catch { return null; }\n",
  );
  const code = setup(root);
  const ran = review(root, ["lenses", code.session]);
  expectSpawnExit(ran, 0);
  expect(ran.stdout).toContain(
    "run   jig.swallowed-failure@1  kept.ts:2 added line matches \\bcatch\\b\n",
  );
  const docsRoot = fixture();
  writeFileSync(join(docsRoot, "README.md"), "Words about catch blocks.\n");
  const docs = setup(docsRoot);
  const skipped = review(docsRoot, ["lenses", docs.session]);
  expectSpawnExit(skipped, 0);
  expect(skipped.stdout).toContain(
    "skip  jig.swallowed-failure@1  no trigger matched\n",
  );
});

test("--json gives each lens's id, version, source, file, decision, reason and match", () => {
  const root = base();
  const [seed] = selected(
    root,
    ["src/a.py"],
    added("src/a.py", "x = 1", "except ValueError:"),
  );
  expect(seed).toEqual({
    id: "jig.swallowed-failure",
    version: 1,
    source: "seed",
    file: resolve(import.meta.dir, "../lenses/jig.swallowed-failure.md"),
    runs: true,
    reason: "src/a.py:2 added line matches \\bexcept\\b",
    match: {
      path: "src/a.py",
      line: 2,
      side: "added",
      pattern: "\\bexcept\\b",
    },
  });
});

test("a removed throw selects the lens; a catch in a test file does not", () => {
  const root = base();
  const removal = selected(
    root,
    ["src/a.ts"],
    removed("src/a.ts", "  throw new NotFound(id);"),
  );
  expect(lens(removal, "jig.swallowed-failure")?.reason).toBe(
    "src/a.ts:3 removed line matches \\bthrow\\b",
  );
  const test = selected(
    root,
    ["src/__tests__/a.test.ts"],
    added("src/__tests__/a.test.ts", "} catch {"),
  );
  expect(lens(test, "jig.swallowed-failure")).toMatchObject({
    runs: false,
    reason: "no trigger matched",
  });
});

test("off skips a lens, --lens runs it whatever its trigger says, and triggers append to its patterns", () => {
  const root = base({
    ".config/jig.yaml":
      "review:\n  lenses:\n    off: [jig.swallowed-failure]\n",
  });
  const diff = added("src/a.ts", "const x = 1;");
  expect(
    lens(selected(root, ["src/a.ts"], diff), "jig.swallowed-failure"),
  ).toMatchObject({ runs: false, reason: "off" });
  expect(
    lens(
      selected(root, ["src/a.ts"], diff, "--lens=jig.swallowed-failure"),
      "jig.swallowed-failure",
    ),
  ).toMatchObject({ runs: true, reason: "--lens" });
  const extended = base({
    ".config/jig.yaml":
      "review:\n  lenses:\n    triggers:\n      jig.swallowed-failure:\n        added_lines: ['\\bquietly\\(']\n        exclude: ['generated/**']\n",
  });
  const files = ["generated/b.ts", "src/a.ts"];
  const both =
    added("generated/b.ts", "} catch {") + added("src/a.ts", "quietly(work);");
  expect(
    lens(selected(extended, files, both), "jig.swallowed-failure")?.reason,
  ).toBe("src/a.ts:1 added line matches \\bquietly\\(");
});

test("a repository lens runs in its base version, and a lens file the change adds is proposed, never run", () => {
  const root = base({
    ".config/jig.yaml": `review:\n  lenses:\n    dir: ${LENS_DIR}\n`,
    [`${LENS_DIR}/LENS-001.md`]: repositoryLens("LENS-001"),
    [`${LENS_DIR}/README.md`]: "How this folder's lenses are written.\n",
  });
  const files = [
    `${LENS_DIR}/LENS-001.md`,
    `${LENS_DIR}/LENS-002.md`,
    "docs/guide.md",
  ];
  const diff =
    added(`${LENS_DIR}/LENS-002.md`, "id: LENS-002") +
    removed(`${LENS_DIR}/LENS-001.md`, "version: 1") +
    added("docs/guide.md", "words");
  const results = selected(root, files, diff);
  expect(lens(results, "LENS-001")).toMatchObject({
    version: 2,
    source: "repository",
    file: join(root, LENS_DIR, "LENS-001.md"),
    runs: true,
    reason: "docs/guide.md matched",
  });
  expect(lens(results, null)).toEqual({
    id: null,
    version: null,
    source: "repository",
    file: `${LENS_DIR}/LENS-002.md`,
    runs: false,
    reason: "proposed",
  });
  const text = select(root, files, diff);
  expectSpawnExit(text, 0);
  expect(text.stdout).toContain(`skip  ${LENS_DIR}/LENS-002.md  proposed\n`);
});

test("a path git quoted is read back, and a path outside the effective file list stops selection", () => {
  const root = base();
  const path = 'src/tab\tq"é.ts';
  const quoted = '"b/src/tab\\tq\\"\\303\\251.ts"';
  const diff = `diff --git "a/src/tab\\tq\\"\\303\\251.ts" ${quoted}\n--- /dev/null\n+++ ${quoted}\n@@ -0,0 +1 @@\n+} catch {\n`;
  expect(
    lens(selected(root, [path], diff), "jig.swallowed-failure")?.runs,
  ).toBe(true);
  const stray = select(root, ["src/a.ts"], added("src/other.ts", "} catch {"));
  expectSpawnExit(stray, 2);
  expect(stray.stderr).toContain("src/other.ts");
});

const CONFIGURATION_ERRORS: [
  string,
  Record<string, string>,
  string[],
  string,
][] = [
  [
    "an unknown id in off",
    {
      ".config/jig.yaml":
        "review:\n  lenses:\n    off: [jig.swallowed-failures]\n",
    },
    [],
    "review.lenses.off names jig.swallowed-failures",
  ],
  [
    "an unknown id in triggers",
    {
      ".config/jig.yaml":
        "review:\n  lenses:\n    triggers:\n      LENS-404: { paths: ['**'] }\n",
    },
    [],
    "review.lenses.triggers names LENS-404",
  ],
  [
    "an unknown id in --lens",
    {},
    ["--lens=jig.nothing"],
    "--lens names jig.nothing",
  ],
  [
    "an invalid pattern",
    {
      ".config/jig.yaml":
        "review:\n  lenses:\n    triggers:\n      jig.swallowed-failure:\n        added_lines: ['(unclosed']\n",
    },
    [],
    "pattern (unclosed is not a valid regular expression",
  ],
  [
    "an unknown trigger key",
    {
      ".config/jig.yaml":
        "review:\n  lenses:\n    triggers:\n      jig.swallowed-failure:\n        added_line: ['x']\n",
    },
    [],
    "unknown key added_line",
  ],
  [
    "a repository lens with the seed prefix",
    {
      ".config/jig.yaml": `review:\n  lenses:\n    dir: ${LENS_DIR}\n`,
      [`${LENS_DIR}/mine.md`]: repositoryLens("jig.mine"),
    },
    [],
    "the jig. prefix is for seed lenses",
  ],
  [
    "a lens whose frontmatter does not parse",
    {
      ".config/jig.yaml": `review:\n  lenses:\n    dir: ${LENS_DIR}\n`,
      [`${LENS_DIR}/broken.md`]: "---\nid: [unclosed\n---\n",
    },
    [],
    "frontmatter does not parse",
  ],
  [
    "a lens directory outside the repository",
    { ".config/jig.yaml": "review:\n  lenses:\n    dir: ../elsewhere\n" },
    [],
    "review.lenses.dir must stay inside the repository",
  ],
];

for (const [name, files, flags, message] of CONFIGURATION_ERRORS)
  test(`a configuration error stops selection and names it: ${name}`, () => {
    const result = select(
      base(files),
      ["src/a.ts"],
      added("src/a.ts", "} catch {"),
      ...flags,
    );
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("select-lenses: configuration error: ");
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

test("a configuration error stops the review's lens step with its message", () => {
  const root = fixture();
  writeFileSync(join(root, "kept.ts"), "base\n} catch {\n");
  const state = setup(root);
  const result = review(root, ["lenses", state.session, "--lens=jig.nothing"]);
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("--lens names jig.nothing");
});
