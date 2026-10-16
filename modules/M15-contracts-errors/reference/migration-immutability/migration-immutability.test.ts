import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "../../../../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  gitEnv,
  type Change,
  parseNameStatus,
} from "./check-no-migration-edits.ts";

const gate = join(import.meta.dir, "check-no-migration-edits.ts");
const fixtures = join(import.meta.dir, "fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

// Every git call here, the gate's included, gets this env: the ambient one
// without the variables a hook exports to point git at the real repository,
// a fixed identity so commits need no configuration, and no global or
// system configuration, so a signing or hooks setting on the machine cannot
// reach the scratch repositories.
const env: Record<string, string | undefined> = {
  ...gitEnv(),
  GIT_AUTHOR_NAME: "Jig Test",
  GIT_AUTHOR_EMAIL: "jig-test@example.invalid",
  GIT_COMMITTER_NAME: "Jig Test",
  GIT_COMMITTER_EMAIL: "jig-test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const scratch = mkdtempSync(join(tmpdir(), "migration-immutability-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A file's content, `null` to delete it, or a symbolic link's target. */
type Edit = string | null | { link: string };
type Commit = Record<string, Edit>;

/**
 * A scratch repository: `main` holds `base`, `feature` branches from its
 * last commit and holds `head`, then `main` goes on with `later`. Paths are
 * relative to `db/migrations` unless they start with `/`.
 */
function scenario(
  name: string,
  {
    base,
    head,
    later = [],
  }: { base: Commit[]; head: Commit[]; later?: Commit[] },
): string {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env, stdio: "pipe" });
    expectSpawnExit(
      { exitCode: result.status, stdout: result.stdout, stderr: result.stderr },
      0,
      `git ${args.join(" ")}`,
    );
    return result.stdout;
  };
  const apply = (commit: Commit, index: number) => {
    for (const [name, edit] of Object.entries(commit)) {
      const path = name.startsWith("/")
        ? join(root, name.slice(1))
        : join(root, "db/migrations", name);
      mkdirSync(dirname(path), { recursive: true });
      if (edit === null) unlinkSync(path);
      else if (typeof edit === "string") writeFileSync(path, edit);
      else {
        rmSync(path, { force: true });
        symlinkSync(edit.link, path);
      }
    }
    git("add", "-A");
    git("commit", "-q", "-m", `commit ${index}`);
  };
  git("init", "-q", "-b", "main");
  base.forEach(apply);
  git("checkout", "-q", "-b", "feature");
  head.forEach(apply);
  git("checkout", "-q", "main");
  later.forEach(apply);
  git("checkout", "-q", "feature");
  return root;
}

function run(args: string[], cwd = scratch) {
  const result = spawnSync(process.execPath, [gate, ...args], {
    cwd,
    env,
    stdio: "pipe",
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** The gate over a scenario's `feature` against `main`. */
const check = (root: string, ...args: string[]) =>
  run([
    "--base",
    "main",
    "--head",
    "feature",
    "--repo",
    root,
    "db/migrations",
    ...args,
  ]);

const applied: Commit = {
  "0001_create_orders.sql": fixture("0001_create_orders.sql"),
  "0002_add_index.sql": fixture("0002_add_index.sql"),
  "/db/migrations/meta/_journal.json": fixture("_journal.json"),
};
const findings = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.includes("[applied-migration-edited]"));

// --- passes ---------------------------------------------------------------

test("a new migration beside the applied ones passes", () => {
  const root = scenario("add", {
    base: [applied],
    head: [{ "0003_add_status.sql": fixture("0003_add_status.sql") }],
  });
  const result = check(root);
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("OK — 2 applied migration(s)");
  expect(result.stdout).toContain("1 added on feature");
});

test("a head with no change to the directory passes", () => {
  const root = scenario("unchanged", {
    base: [applied],
    head: [{ "/README.md": "not a migration\n" }],
  });
  expectSpawnExit(check(root), 0);
});

test("a migration added on the head and edited there again passes", () => {
  const root = scenario("added-then-edited", {
    base: [applied],
    head: [
      { "0003_add_status.sql": fixture("0002_add_index.edited.sql") },
      { "0003_add_status.sql": fixture("0003_add_status.sql") },
    ],
  });
  expectSpawnExit(check(root), 0);
});

test("the ledger and other metadata beside the files may change", () => {
  const root = scenario("metadata", {
    base: [applied],
    head: [{ "/db/migrations/meta/_journal.json": '{ "entries": [] }\n' }],
  });
  expectSpawnExit(check(root), 0);
});

test("restoring an applied migration to a state the base held passes", () => {
  const root = scenario("restored", {
    base: [
      applied,
      { "0002_add_index.sql": fixture("0002_add_index.edited.sql") },
    ],
    head: [{ "0002_add_index.sql": fixture("0002_add_index.sql") }],
  });
  const result = check(root);
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("1 restored to a prior state");
});

test("a state the base branch reached after the fork counts as prior", () => {
  const root = scenario("restored-to-later", {
    base: [applied],
    head: [{ "0002_add_index.sql": fixture("0002_add_index.edited.sql") }],
    later: [{ "0002_add_index.sql": fixture("0002_add_index.edited.sql") }],
  });
  expectSpawnExit(check(root), 0);
});

// --- findings -------------------------------------------------------------

test("an edited applied migration is a finding that names the file", () => {
  const root = scenario("edited", {
    base: [applied],
    head: [{ "0002_add_index.sql": fixture("0002_add_index.edited.sql") }],
  });
  const result = check(root);
  expectSpawnExit(result, 1);
  const lines = findings(result.stderr);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("db/migrations/0002_add_index.sql");
  expect(lines[0]).toContain("modified to content it never held on main");
  expect(result.stderr).toContain("fix forward");
});

test("an edit to content the path never held, after an earlier edit, is a finding", () => {
  const root = scenario("edited-again", {
    base: [
      applied,
      { "0002_add_index.sql": fixture("0002_add_index.edited.sql") },
    ],
    head: [
      { "0002_add_index.sql": fixture("0002_add_index.edited-again.sql") },
    ],
  });
  expectSpawnExit(check(root), 1);
});

test("a deleted applied migration is a finding", () => {
  const root = scenario("deleted", {
    base: [applied],
    head: [{ "0002_add_index.sql": null }],
  });
  const result = check(root);
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("was deleted");
});

test("a renamed applied migration is a finding under its applied name", () => {
  const root = scenario("renamed", {
    base: [applied],
    head: [
      {
        "0002_add_index.sql": null,
        "0002_add_orders_index.sql": fixture("0002_add_index.sql"),
      },
    ],
  });
  const result = check(root);
  expectSpawnExit(result, 1);
  const lines = findings(result.stderr);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("db/migrations/0002_add_index.sql");
  expect(lines[0]).toContain(
    "renamed to db/migrations/0002_add_orders_index.sql",
  );
});

test("a link whose target text equals the applied content is a finding", () => {
  // The blob of a link is its target path, so a link to a file named like
  // the applied content shares the content's blob; only the mode differs.
  const root = scenario("type-changed", {
    base: [{ ...applied, "0002_add_index.sql": "0001_create_orders.sql" }],
    head: [{ "0002_add_index.sql": { link: "0001_create_orders.sql" } }],
  });
  const result = check(root);
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("changed type");
});

test("each changed applied migration is its own finding", () => {
  const root = scenario("several", {
    base: [applied],
    head: [
      {
        "0001_create_orders.sql": null,
        "0002_add_index.sql": fixture("0002_add_index.edited.sql"),
        "0003_add_status.sql": fixture("0003_add_status.sql"),
      },
    ],
  });
  const result = check(root);
  expectSpawnExit(result, 1);
  expect(findings(result.stderr)).toHaveLength(2);
  expect(result.stderr).toContain(
    "2 applied migration(s) under db/migrations changed",
  );
});

test("--match says which paths are migrations", () => {
  const root = scenario("match", {
    base: [{ ...applied, "0004_backfill.py": fixture("0004_backfill.py") }],
    head: [{ "0004_backfill.py": "def upgrade():\n    return None\n" }],
  });
  expectSpawnExit(check(root), 0);
  expectSpawnExit(check(root, "--match", "\\.py$"), 1);
});

test("--head defaults to HEAD and --repo to the working directory", () => {
  const root = scenario("defaults", {
    base: [applied],
    head: [{ "0002_add_index.sql": fixture("0002_add_index.edited.sql") }],
  });
  expectSpawnExit(run(["--base", "main", "db/migrations"], root), 1);
  expectSpawnExit(
    run(["--base", "main", join(root, "db/migrations")], root),
    1,
  );
});

// --- could not check ------------------------------------------------------

test("a directory with no migration file at either side is not a pass", () => {
  const root = scenario("no-files", {
    base: [applied],
    head: [{ "0003_add_status.sql": fixture("0003_add_status.sql") }],
  });
  const result = check(root, "--match", "\\.rb$");
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("no migration file");
  expectSpawnExit(
    run([
      "--base",
      "main",
      "--head",
      "feature",
      "--repo",
      root,
      "db/elsewhere",
    ]),
    2,
  );
});

test("a directory outside the repository is not a pass", () => {
  const root = scenario("outside", { base: [applied], head: [] });
  expectSpawnExit(
    run([
      "--base",
      "main",
      "--head",
      "feature",
      "--repo",
      root,
      "../elsewhere",
    ]),
    2,
  );
});

test("a reference that names no commit, or no merge base, is not a pass", () => {
  const root = scenario("refs", { base: [applied], head: [] });
  expectSpawnExit(
    run([
      "--base",
      "origin/main",
      "--head",
      "feature",
      "--repo",
      root,
      "db/migrations",
    ]),
    2,
  );
  expectSpawnExit(
    run([
      "--base",
      "main",
      "--head",
      "nowhere",
      "--repo",
      root,
      "db/migrations",
    ]),
    2,
  );
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: root, env, stdio: "pipe" });
  git("checkout", "-q", "--orphan", "unrelated");
  git("commit", "-q", "--allow-empty", "-m", "no shared history");
  const result = run([
    "--base",
    "main",
    "--head",
    "unrelated",
    "--repo",
    root,
    "db/migrations",
  ]);
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("merge-base");
});

test("a directory that is not a repository is not a pass", () => {
  const root = join(scratch, "not-a-repo");
  mkdirSync(join(root, "db/migrations"), { recursive: true });
  writeFileSync(join(root, "db/migrations/0001.sql"), "SELECT 1;\n");
  const result = run(
    ["--base", "main", "--head", "HEAD", "--repo", root, "db/migrations"],
    root,
  );
  expectSpawnExit(result, 2);
});

for (const args of [
  [],
  ["db/migrations"],
  ["--base", "main"],
  ["--base", "main", "db/migrations", "db/other"],
  ["--base", "main", "--match", "(", "db/migrations"],
  ["--base", "main", "--frobnicate", "db/migrations"],
  ["--base"],
])
  test(`fails closed on the arguments ${JSON.stringify(args)}`, () => {
    const root = scenario(
      `usage-${args.join("-").replaceAll(/[^\w-]/g, "_")}`,
      {
        base: [applied],
        head: [],
      },
    );
    const result = run(args, root);
    expectSpawnExit(result, 2);
    expect(result.stdout).not.toContain("OK");
  });

// --- the parser -----------------------------------------------------------

test("parseNameStatus reads the entries of git diff --name-status -z", () => {
  const output = "M\0a.sql\0R100\0b.sql\0c.sql\0D\0d.sql\0T\0e.sql\0";
  const expected: Change[] = [
    { status: "M", path: "a.sql" },
    { status: "R", path: "b.sql", renamedTo: "c.sql" },
    { status: "D", path: "d.sql" },
    { status: "T", path: "e.sql" },
  ];
  expect(parseNameStatus(output)).toEqual(expected);
  expect(parseNameStatus("")).toEqual([]);
  expect(() => parseNameStatus("A\0a.sql\0")).toThrow("unexpected status");
  expect(() => parseNameStatus("R100\0b.sql\0")).toThrow("mid-entry");
  expect(() => parseNameStatus("M\0")).toThrow("mid-entry");
});

test("gitEnv drops the variables that route git elsewhere, in any case", () => {
  const env = gitEnv({
    PATH: "/bin",
    GIT_DIR: "/elsewhere/.git",
    Git_Work_Tree: "/elsewhere",
    GIT_CONFIG: "/elsewhere/config",
    GIT_AUTHOR_NAME: "kept",
  });
  expect(env).toEqual({ PATH: "/bin", GIT_AUTHOR_NAME: "kept" });
});
