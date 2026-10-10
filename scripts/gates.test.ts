import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { remediation } from "./check-branch-protection.ts";
import { LEAKY_GIT_ENV, spawnSync } from "../lib/guarded-git-spawn.ts";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";

// Filter after merging overrides, including Windows' case-insensitive spelling.
function safeSpawn(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  );
  const [executable, ...args] = command;
  if (!executable) throw new Error("Missing subprocess executable");
  const result = spawnSync(executable, args, { ...options, env });
  return { ...result, exitCode: result.status };
}

const root = resolve(import.meta.dir, "..");
const fixtures = join(import.meta.dir, "tests/fixtures");
const temporary: string[] = [];
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "groundwork-gates-"));
  temporary.push(path);
  return path;
}
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});
function run(gate: string, args: string[] = [], cwd = root) {
  return safeSpawn(
    [process.execPath, join(import.meta.dir, `${gate}.ts`), ...args],
    { cwd },
  );
}
const cases: [string, string, string[], number][] = [
  ["check-md-links", "pass", ["."], 0],
  ["check-md-tables", "pass", ["."], 0],
  ["check-glossary-coverage", "pass", [".", "GLOSSARY.md", "allowlist.txt"], 0],
  ["check-md-links", "fail-link", ["."], 1],
  ["check-md-tables", "fail-table", ["."], 1],
  [
    "check-glossary-coverage",
    "fail-glossary",
    [".", "GLOSSARY.md", "allowlist.txt"],
    1,
  ],
  ["check-no-tracker-refs", "pass", ["."], 0],
  ...[
    "fail-tracker",
    "fail-tracker-link",
    "fail-tracker-unicode",
    "fail-tracker-basename",
  ].map((name): [string, string, string[], number] => [
    "check-no-tracker-refs",
    name,
    ["."],
    1,
  ]),
  ["check-no-tracker-refs", "fail-tracker-badregex", [".", "patterns.txt"], 2],
  ["check-no-tracker-refs", "pass", ["./does-not-exist"], 2],
  [
    "check-no-tracker-refs",
    "fail-tracker-multipattern",
    [".", "patterns.txt"],
    2,
  ],
];
for (const [gate, fixture, args, status] of cases)
  test(`${gate}: ${fixture} exits ${status}`, () => {
    expectSpawnExit(run(gate, args, join(fixtures, fixture)), status);
    if (process.env.GROUNDWORK_BASH_PARITY === "1") {
      const legacy = safeSpawn(
        [
          "bash",
          join(root, ".context/bash-baseline/scripts", `${gate}.sh`),
          ...args,
        ],
        { cwd: join(fixtures, fixture) },
      );
      expectSpawnExit(legacy, status);
    }
  });
for (const [name, status] of [
  ["compliant", 0],
  ["unprotected", 1],
  ["partial", 1],
  ["malformed", 2],
  ["wrong-type", 2],
  ["bad-types", 2],
] as const)
  test(`branch protection: ${name}`, () => {
    const args = [
      "--input",
      join(fixtures, "branch-protection", `${name}.json`),
      "example/repo",
      "main",
    ];
    expectSpawnExit(run("check-branch-protection", args, tmpdir()), status);
    if (process.env.GROUNDWORK_BASH_PARITY === "1")
      expectSpawnExit(
        safeSpawn([
          "bash",
          join(
            root,
            ".context/bash-baseline/scripts/check-branch-protection.sh",
          ),
          ...args,
        ]),
        status,
      );
  });
for (const [fixture, needle] of [
  ["unprotected", "FAIL  required CI status check(s) configured"],
  ["unprotected", "FAIL  force-push disallowed"],
  ["unprotected", "FAIL  branch deletion disallowed"],
  ["unprotected", "0/7 controls satisfied"],
  ["partial", "FAIL  required conversation resolution"],
  ["partial", "FAIL  administrator enforcement"],
  ["partial", "PASS  at least one required human review"],
  ["partial", "PASS  required status checks are strict"],
  ["partial", "release-bot"],
  ["compliant", "7/7 controls satisfied"],
])
  test(`branch report includes ${needle}`, () =>
    expect(
      run("check-branch-protection", [
        "--input",
        join(fixtures, "branch-protection", `${fixture}.json`),
      ]).stdout.toString(),
    ).toContain(needle ?? ""));
test("offline branch audit needs no origin", () =>
  expectSpawnExit(
    run(
      "check-branch-protection",
      ["--input", join(fixtures, "branch-protection/compliant.json")],
      tmpdir(),
    ),
    0,
  ));
test("remediation preserves stricter review and app-bound checks", () => {
  const input = JSON.parse(
    readFileSync(join(fixtures, "branch-protection/compliant.json"), "utf8"),
  );
  input.required_pull_request_reviews.required_approving_review_count = 3;
  input.required_pull_request_reviews.require_last_push_approval = true;
  input.required_status_checks.checks = [{ context: "gates", app_id: 42 }];
  const patched = remediation(input);
  expect(patched.required_pull_request_reviews).toMatchObject({
    required_approving_review_count: 3,
    require_last_push_approval: true,
  });
  expect(patched.required_status_checks).toMatchObject({
    checks: [{ context: "gates", app_id: 42 }],
  });
});
test("ignored workspace excluded; non-ignored untracked content checked", () => {
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  writeFileSync(join(dir, ".gitignore"), ".context/\n");
  writeFileSync(join(dir, "README.md"), "# Good\n\nRepository content.\n");
  writeFileSync(
    join(dir, "GLOSSARY.md"),
    "# Glossary\n\nHITL is defined here.\n",
  );
  writeFileSync(join(dir, "allowlist.txt"), "# none\n");
  mkdirSync(join(dir, ".context"));
  const bad = "# Bad\nText\n| table |\n[missing](nowhere.md)\nUNDEFINEDTERM\n";
  writeFileSync(join(dir, ".context/ignored.md"), bad);
  for (const gate of ["check-md-links", "check-md-tables"])
    expectSpawnExit(run(gate, [dir]), 0);
  const glossaryArgs = [
    dir,
    join(dir, "GLOSSARY.md"),
    join(dir, "allowlist.txt"),
  ];
  expectSpawnExit(run("check-glossary-coverage", glossaryArgs), 0);
  writeFileSync(join(dir, "untracked.md"), bad);
  for (const gate of ["check-md-links", "check-md-tables"])
    expectSpawnExit(run(gate, [dir]), 1);
  expectSpawnExit(run("check-glossary-coverage", glossaryArgs), 1);
});
const unixPermissions =
  process.platform !== "win32" && process.getuid?.() !== 0;
test.skipIf(!unixPermissions)(
  "unreadable patterns and inaccessible tracked files fail closed",
  () => {
    const dir = temp();
    const patterns = join(dir, "patterns.txt");
    writeFileSync(patterns, "EXAMPLE-[0-9]+\n");
    chmodSync(patterns, 0);
    try {
      expectSpawnExit(
        run("check-no-tracker-refs", [join(fixtures, "pass"), patterns]),
        2,
      );
    } finally {
      chmodSync(patterns, 0o644);
    }
    expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
    mkdirSync(join(dir, "locked"));
    writeFileSync(
      join(dir, "locked/notes.md"),
      "See " + "DOC" + "-1 for why.\n",
    );
    expectSpawnExit(safeSpawn(["git", "-C", dir, "add", "locked/notes.md"]), 0);
    chmodSync(join(dir, "locked"), 0);
    try {
      expectSpawnExit(run("check-no-tracker-refs", [dir]), 2);
    } finally {
      chmodSync(join(dir, "locked"), 0o755);
    }
  },
);

test("POSIX regex classes retain tracker pattern matching", async () => {
  const { ere } = await import("../lib/cli.ts");
  expect(ere("[[:punct:]]").test("!")).toBe(true);
  expect(ere("[[:punct:]]").test("A")).toBe(false);
  expect(ere("[[:cntrl:]]").test("\t")).toBe(true);
  expect(() => ere("[[:unknown:]]")).toThrow();
});

test("the test step leaves out POSIX-only suites on Windows and separate suites on request", async () => {
  const {
    POSIX_ONLY_SUITES,
    SEPARATE_SUITES,
    SKIP_SEPARATE_ENV,
    skippedSuites,
    testArgs,
  } = await import("./gates.ts");
  expect(skippedSuites("linux", {})).toEqual([]);
  expect(skippedSuites("darwin", { [SKIP_SEPARATE_ENV]: "1" })).toEqual(
    SEPARATE_SUITES,
  );
  const windows = skippedSuites("win32", { [SKIP_SEPARATE_ENV]: "1" });
  for (const suite of [...POSIX_ONLY_SUITES, ...SEPARATE_SUITES])
    expect(windows).toContain(suite);
  expect(testArgs([], ["**/fixtures/**"])).toEqual(["run", "test"]);
  // Bun replaces the configured ignore list, so it must be passed along.
  expect(testArgs(["suite/**"], ["**/fixtures/**"])).toEqual([
    "run",
    "test",
    "--path-ignore-patterns=**/fixtures/**",
    "--path-ignore-patterns=suite/**",
  ]);
});

test("every suite the gate job leaves out runs in its own CI job", async () => {
  const { SEPARATE_SUITES, SKIP_SEPARATE_ENV } = await import("./gates.ts");
  const { load } = await import("js-yaml");
  const workflow = load(
    readFileSync(join(root, ".github/workflows/gates.yml"), "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        env?: Record<string, string>;
        needs?: string[];
        steps?: { run?: string }[];
      }
    >;
  };
  const jobs = workflow.jobs;
  expect(jobs["platform-gates"]?.env?.[SKIP_SEPARATE_ENV]).toBe("1");
  const runs = (jobs["drive-pr-suite"]?.steps ?? []).map((s) => s.run ?? "");
  for (const suite of SEPARATE_SUITES) {
    const dir = suite.replace(/\*\*$/, "");
    expect(runs.some((run) => run.includes(`./${dir}`))).toBe(true);
  }
  expect(
    runs.some((run) => run.includes("terminal-states-consistency.ts")),
  ).toBe(true);
  // The required status check `gates` must wait for the separate job too.
  expect(jobs.gates?.needs).toEqual(["platform-gates", "drive-pr-suite"]);
});
