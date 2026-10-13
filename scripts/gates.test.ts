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
import { checkAuditFit } from "./check-audit-fit.ts";
import { checkWorkflowSafety } from "./check-workflow-safety.ts";
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
// The fixtures use neutral patterns; the real ones are tested at run time
// below, so no fixture has to spell out what the gate forbids.
const trackerPatterns = join(fixtures, "tracker-key-patterns.txt");
const temporary: string[] = [];
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "jig-gates-"));
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
  ["check-no-tracker-refs", "pass", [".", trackerPatterns], 0],
  ["check-no-tracker-refs", "pass-tracker-allow", [".", trackerPatterns], 0],
  ...[
    "fail-tracker",
    "fail-tracker-link",
    "fail-tracker-unicode",
    "fail-tracker-basename",
  ].map((name): [string, string, string[], number] => [
    "check-no-tracker-refs",
    name,
    [".", trackerPatterns],
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
    if (process.env.JIG_BASH_PARITY === "1") {
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
    if (process.env.JIG_BASH_PARITY === "1")
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
  ["unprotected", "0/4 controls satisfied"],
  ["partial", "FAIL  required conversation resolution"],
  ["partial", "not required by policy: strict checks on, approving reviews 1"],
  ["partial", "release-bot"],
  ["compliant", "4/4 controls satisfied"],
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
test("an unstrict branch with no required review or admin enforcement complies", () => {
  const input = JSON.parse(
    readFileSync(join(fixtures, "branch-protection/compliant.json"), "utf8"),
  );
  input.required_status_checks.strict = false;
  input.required_pull_request_reviews.required_approving_review_count = 0;
  input.enforce_admins.enabled = false;
  const file = join(temp(), "jig-policy.json");
  writeFileSync(file, JSON.stringify(input));
  const result = run("check-branch-protection", ["--input", file]);
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain(
    "not required by policy: strict checks off, approving reviews 0, administrator enforcement off",
  );
  expect(remediation(input)).toMatchObject({
    required_status_checks: { strict: false },
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 0 },
  });
});
test("remediation keeps pull-request review protection off when it is off", () => {
  const input = JSON.parse(
    readFileSync(join(fixtures, "branch-protection/compliant.json"), "utf8"),
  );
  input.required_pull_request_reviews = null;
  input.required_conversation_resolution.enabled = false;
  expect(remediation(input).required_pull_request_reviews).toBeNull();
  delete input.required_pull_request_reviews;
  expect(remediation(input).required_pull_request_reviews).toBeNull();
});
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

test("the real patterns reject the original tracker keys and organization name, outside the allowed places", () => {
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  const name = ["Doc", "omply"].join("");
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
    expectSpawnExit(safeSpawn(["git", "-C", dir, "add", path]), 0);
  };
  const check = () => run("check-no-tracker-refs", [dir]);
  write(
    "README.md",
    [
      `Install from https://github.com/${name.toLowerCase()}/jig.git`,
      `See https://github.com/${name.toLowerCase()}/jig/blob/main/README.md`,
      `Hosted at https://github.com/${name.toLowerCase()}/jig.`,
      "",
    ].join("\n"),
  );
  write(
    "plugin/.claude-plugin/plugin.json",
    `{\n  "author": { "name": "${name}" }\n}\n`,
  );
  write(".config/jig.yaml", `team: ${name}\n`);
  expectSpawnExit(check(), 0);
  for (const content of [
    `See ${["DOC", "1234"].join("-")}.\n`,
    `Built at ${name}.\n`,
    `export const STATE = "~/.${name.toLowerCase()}/state";\n`,
    `See https://github.com/${name.toLowerCase()}/other-repo.\n`,
    // The exemption ends at the repository name, not at a word boundary.
    `See https://github.com/${name.toLowerCase()}/jig-other.\n`,
    `See https://github.com/${name.toLowerCase()}/jig.github.io.\n`,
    `See https://github.com/${name.toLowerCase()}/jig_x.\n`,
    `See https://github.com/${name.toLowerCase()}/jig..private.\n`,
    // The exemption starts at the whole address, not inside another host.
    `See https://notgithub.com/${name.toLowerCase()}/jig.\n`,
    `See https://evil.github.com/${name.toLowerCase()}/jig.\n`,
    // An allowed occurrence exempts itself, not the line it sits on.
    `https://github.com/${name.toLowerCase()}/jig, built at ${name}.\n`,
  ]) {
    write("notes.md", content);
    expectSpawnExit(check(), 1);
  }
  write("notes.md", "Nothing to see.\n");
  for (const content of [
    `{\n  "author": { "name": "${name}" }, "see": "${["DOC", "1"].join("-")}"\n}\n`,
    `{\n  "homepage": "${name}"\n}\n`,
  ]) {
    write("plugin/.claude-plugin/plugin.json", content);
    expectSpawnExit(check(), 1);
  }
});

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
  // The pre-push hook's fast set: format, lint and types, then every
  // repository check; the full set starts the same way and adds the rest.
  const { plan, CHECKS } = await import("./gates.ts");
  const full = plan(false, ["run", "test"]);
  const fast = plan(true, ["run", "test"]);
  expect(fast.steps).toEqual([
    ["run", "format:check"],
    ["run", "lint"],
    ["run", "typecheck"],
  ]);
  expect(full.steps.slice(0, fast.steps.length)).toEqual(fast.steps);
  expect(full.steps).toContainEqual(["run", "test"]);
  expect(fast.checks).toEqual(CHECKS);
  expect(full.checks).toEqual(CHECKS);
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
  expect(jobs.gates?.needs).toEqual([
    "areas",
    "platform-gates",
    "drive-pr-suite",
  ]);
});

test("the workflow selects jobs by area names the change-area catalog defines", async () => {
  const { CATALOG, readCatalog } = await import("./change-areas.ts");
  const { load } = await import("js-yaml");
  const workflow = readFileSync(
    join(root, ".github/workflows/gates.yml"),
    "utf8",
  );
  const { areas } = readCatalog(join(root, CATALOG)) as {
    areas: Record<string, unknown>;
  };
  const named = [...workflow.matchAll(/'"([a-z0-9-]+)"'/g)].map((m) => m[1]);
  expect(named.length).toBeGreaterThan(0);
  for (const name of named) expect(Object.keys(areas)).toContain(name ?? "");
  const jobs = (
    load(workflow) as {
      jobs: Record<string, { if?: string; needs?: string | string[] }>;
    }
  ).jobs;
  expect(jobs["drive-pr-suite"]?.if).toContain('"drive-pr"');
  expect(jobs["platform-gates"]?.needs).toBe("areas");
});

test("the changelog must carry the current plugin version", async () => {
  const { checkChangelog, changelogVersions } = await import(
    "./check-changelog.ts"
  );
  expect(
    changelogVersions(
      "# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-01-01\n",
    ),
  ).toEqual(["Unreleased", "1.2.0"]);
  expect(
    changelogVersions("# Changelog\n\n```markdown\n## [1.2.0]\n```\n"),
  ).toEqual([]);
  const dir = temp();
  const manifest = (tool: string, version: string) => {
    mkdirSync(join(dir, "plugin", `.${tool}-plugin`), { recursive: true });
    writeFileSync(
      join(dir, "plugin", `.${tool}-plugin`, "plugin.json"),
      JSON.stringify({ version }),
    );
  };
  manifest("claude", "1.2.0");
  manifest("codex", "1.2.0");
  writeFileSync(join(dir, "CHANGELOG.md"), "## [1.1.0] - 2026-01-01\n");
  expect(checkChangelog(dir)).toBe(1);
  writeFileSync(join(dir, "CHANGELOG.md"), "## [1.2.0] - 2026-01-02\n");
  expect(checkChangelog(dir)).toBe(0);
  manifest("codex", "1.3.0");
  expect(checkChangelog(dir)).toBe(1);
  expect(checkChangelog(root)).toBe(0);
});

test("Jig's workflows pass the PR-target safety lint, and an unsafe one fails it", () => {
  expect(checkWorkflowSafety(root)).toBe(0);
  const fixtures = join(
    root,
    "modules/M7-pr-lifecycle-review/reference/pr-target-safety/fixtures",
  );
  const dir = temp();
  const workflows = join(dir, ".github/workflows");
  mkdirSync(workflows, { recursive: true });
  expect(checkWorkflowSafety(dir)).toBe(0);
  writeFileSync(
    join(workflows, "review.yml"),
    readFileSync(join(fixtures, "unsafe/folded-ref-run.yml")),
  );
  expect(checkWorkflowSafety(dir)).toBe(1);
  expect(checkWorkflowSafety(join(dir, "missing"))).toBe(0);
});

test("the paths Jig's instruction files name exist", () => {
  const gate = "check-instruction-paths";
  expectSpawnExit(run(gate, [root]), 0);
  const dir = temp();
  mkdirSync(join(dir, "lib/templates"), { recursive: true });
  writeFileSync(join(dir, "lib/templates/a.md"), "");
  writeFileSync(join(dir, "lib/cli.ts"), "");
  const agents = join(dir, "AGENTS.md");
  writeFileSync(
    agents,
    "Run `lib/cli.ts`, then `/review` or `/jig:audit`; keep `templates/` apart.\n",
  );
  expectSpawnExit(run(gate, [dir]), 0);
  writeFileSync(agents, "Run `lib/missing.ts`.\n");
  expectSpawnExit(run(gate, [dir]), 1);
  mkdirSync(join(dir, "fixtures"));
  writeFileSync(join(dir, "fixtures/AGENTS.md"), "Run `lib/missing.ts`.\n");
  writeFileSync(agents, "Nothing named.\n");
  expectSpawnExit(run(gate, [dir]), 0);
});

test("the licence files hold together, and each gap fails", () => {
  const gate = "check-licences";
  expectSpawnExit(run(gate, [root]), 0);
  const dir = temp();
  const put = (path: string, text = "x\n") => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const notice = (templates: string[], licences: string[]) =>
    `Jig\n\nTemplates:\n\n${templates.join("\n")}\n\nThird-party code:\n\n${licences.map((l) => `${l}\n  a library`).join("\n")}\n`;
  const write = (templates: string[], licences: string[]) => {
    for (const f of ["NOTICE", "plugin/NOTICE"])
      put(f, notice(templates, licences));
  };
  for (const f of ["LICENSE", "LICENSE-MIT-0", "plugin/LICENSE"])
    put(f, "licence\n");
  put("modules/M0-a/templates/a.md");
  put("plugin/x/vendor/lib.mjs");
  put("plugin/x/vendor/lib.LICENSE");
  write(["modules/M0-a/templates/a.md"], ["plugin/x/vendor/lib.LICENSE"]);
  expectSpawnExit(run(gate, [dir]), 0);
  // A template NOTICE does not list.
  put("modules/M0-a/templates/b.md");
  expectSpawnExit(run(gate, [dir]), 1);
  write(
    ["modules/M0-a/templates/a.md", "modules/M0-a/templates/b.md"],
    ["plugin/x/vendor/lib.LICENSE"],
  );
  expectSpawnExit(run(gate, [dir]), 0);
  // The plugin's copy drifts from the root file.
  put("plugin/LICENSE", "other\n");
  expectSpawnExit(run(gate, [dir]), 1);
  put("plugin/LICENSE", "licence\n");
  // A licence file NOTICE does not list, and a vendor folder without one.
  put("plugin/y/LICENSE");
  put("plugin/z/vendor/lib.mjs");
  const result = run(gate, [dir]);
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("plugin/y/LICENSE is not listed");
  expect(result.stderr.toString()).toContain("plugin/z/vendor/: vendored code");
  rmSync(join(dir, "plugin/y"), { recursive: true });
  rmSync(join(dir, "plugin/z"), { recursive: true });
  // Seeds and fixtures are out of scope, vendored code included.
  put("tests/fixtures/vendor/lib.mjs");
  put("tests/fixtures/vendor/LICENSE");
  put("seeds/s/vendor/lib.mjs");
  expectSpawnExit(run(gate, [dir]), 0);
  // A listed path with a space in it.
  put("modules/M0-a/templates/my template.md");
  const templates = [
    "modules/M0-a/templates/a.md",
    "modules/M0-a/templates/b.md",
    "modules/M0-a/templates/my template.md",
  ];
  write(templates, ["plugin/x/vendor/lib.LICENSE"]);
  expectSpawnExit(run(gate, [dir]), 0);
  // A listed path with a space in it that is gone is still listed.
  rmSync(join(dir, "modules/M0-a/templates/my template.md"));
  const gone = run(gate, [dir]);
  expectSpawnExit(gone, 1);
  expect(gone.stderr.toString()).toContain(
    "modules/M0-a/templates/my template.md is listed as a template but does not exist",
  );
  put("modules/M0-a/templates/my template.md");
  put("plugin/s p/vendor/lib.mjs");
  put("plugin/s p/vendor/LICENSE");
  write(templates, [
    "plugin/x/vendor/lib.LICENSE",
    "plugin/s p/vendor/LICENSE",
  ]);
  expectSpawnExit(run(gate, [dir]), 0);
  rmSync(join(dir, "plugin/s p"), { recursive: true });
  const removed = run(gate, [dir]);
  expectSpawnExit(removed, 1);
  expect(removed.stderr.toString()).toContain(
    "licence file plugin/s p/vendor/LICENSE does not exist",
  );
  write(templates, ["plugin/x/vendor/lib.LICENSE"]);
  // An entry after a blank line is still in its list.
  const spacedEntries = [
    {
      extra: "\nmodules/M0-a/templates/gone.md\n",
      problem:
        "modules/M0-a/templates/gone.md is listed as a template but does not exist",
    },
    {
      extra: "\n\nplugin/gone/LICENSE\n",
      problem: "licence file plugin/gone/LICENSE does not exist",
    },
  ];
  for (const { extra, problem } of spacedEntries) {
    const text = notice(templates, ["plugin/x/vendor/lib.LICENSE"]);
    const at = extra.includes("templates")
      ? text.indexOf("\n\nThird-party")
      : text.length;
    for (const f of ["NOTICE", "plugin/NOTICE"])
      put(f, text.slice(0, at) + "\n" + extra + text.slice(at));
    const spaced = run(gate, [dir]);
    expectSpawnExit(spaced, 1);
    expect(spaced.stderr.toString()).toContain(problem);
  }
  write(templates, ["plugin/x/vendor/lib.LICENSE"]);
  // A listed path that contains the third-party heading's words.
  put("modules/M0-a/templates/Third-party code notes.md");
  write(
    [...templates, "modules/M0-a/templates/Third-party code notes.md"],
    ["plugin/x/vendor/lib.LICENSE"],
  );
  expectSpawnExit(run(gate, [dir]), 0);
  rmSync(join(dir, "modules/M0-a/templates/Third-party code notes.md"));
  write(templates, ["plugin/x/vendor/lib.LICENSE"]);
  // A listed file that is not a licence does not cover its vendor folder.
  write(templates, ["plugin/x/vendor/lib.LICENSE", "plugin/q/vendor/lib.mjs"]);
  put("plugin/q/vendor/lib.mjs");
  const unlicensed = run(gate, [dir]);
  expectSpawnExit(unlicensed, 1);
  expect(unlicensed.stderr.toString()).toContain(
    "plugin/q/vendor/lib.mjs is listed as a licence but is not a licence file",
  );
  expect(unlicensed.stderr.toString()).toContain(
    "plugin/q/vendor/: vendored code",
  );
  rmSync(join(dir, "plugin/q"), { recursive: true });
  write(templates, ["plugin/x/vendor/lib.LICENSE"]);
  // A listed licence deleted but not yet staged is missing.
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  expectSpawnExit(safeSpawn(["git", "-C", dir, "add", "-A"]), 0);
  expectSpawnExit(run(gate, [dir]), 0);
  rmSync(join(dir, "plugin/x/vendor/lib.LICENSE"));
  const deleted = run(gate, [dir]);
  expectSpawnExit(deleted, 1);
  expect(deleted.stderr.toString()).toContain(
    "licence file plugin/x/vendor/lib.LICENSE does not exist",
  );
});

test("check-audit-fit passes on Jig and fails until a new criterion is scored", async () => {
  expect(await checkAuditFit(root)).toBe(0);
  const dir = temp();
  safeSpawn(["git", "init", "-q", dir]);
  const criteria = join(dir, "criteria");
  mkdirSync(join(dir, ".config"), { recursive: true });
  mkdirSync(criteria);
  writeFileSync(
    join(criteria, "M1-gates.yaml"),
    "module: M1\nname: gates\npurpose: P.\ncriteria:\n  - { id: a, level: lite, requires: convention, statement: A., observe: [a] }\n",
  );
  const record = (criteria: string) =>
    `version: 1\nplugin_version: 0.0.0\ndate: "2026-01-01"\ncommit: abc\nshape: library\ncriteria:\n${criteria}`;
  const a = '  M1/a: { score: convention, evidence: "AGENTS.md" }\n';
  writeFileSync(join(dir, ".config/jig-audit.yaml"), record(a));
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  writeFileSync(join(dir, ".config/jig.yaml"), "other_tool:\n  key: 1\n");
  expect(await checkAuditFit(dir, criteria)).toBe(0);

  writeFileSync(
    join(criteria, "M1-gates.yaml"),
    `${readFileSync(join(criteria, "M1-gates.yaml"), "utf8")}  - { id: b, level: lite, requires: convention, statement: B., observe: [b] }\n`,
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  writeFileSync(
    join(dir, ".config/jig-audit.yaml"),
    record(`${a}  M1/b: { score: absent, evidence: "none" }\n`),
  );
  expect(await checkAuditFit(dir, criteria)).toBe(0);

  writeFileSync(join(dir, "package.json"), '{"scripts": {"gates": "x"}}');
  writeFileSync(
    join(dir, ".config/jig.yaml"),
    "gates:\n  comand: npm run gates\n",
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  writeFileSync(
    join(dir, ".config/jig.yaml"),
    "gates:\n  command: npm run missing\n",
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  writeFileSync(
    join(dir, ".config/jig-audit.yaml"),
    `${record(`${a}  M1/b: { score: absent, evidence: "none" }\n`)}declined:\n  - refs: ["config/derivation:gates.command"]\n    reason: Not now.\n    revisit_when: Later.\n`,
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  // Declining an unknown field does not get it past the gate.
  writeFileSync(
    join(dir, ".config/jig.yaml"),
    "gates:\n  comand: npm run gates\n",
  );
  writeFileSync(
    join(dir, ".config/jig-audit.yaml"),
    `${record(`${a}  M1/b: { score: absent, evidence: "none" }\n`)}declined:\n  - refs: ["config/unknown:gates.comand"]\n    reason: Not now.\n    revisit_when: Later.\n`,
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);

  rmSync(join(dir, ".config/jig-audit.yaml"));
  expect(await checkAuditFit(dir, criteria)).toBe(2);
});
