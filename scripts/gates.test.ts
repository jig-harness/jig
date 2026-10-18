import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { remediation } from "./check-branch-protection.ts";
import { checkAuditFit } from "./check-audit-fit.ts";
import { checkWorkflowSafety } from "./check-workflow-safety.ts";
import { checkWorkflowConventions } from "./check-workflow-conventions.ts";
import { checkSchedulesDeclared } from "./check-schedules-declared.ts";
import { readPatterns } from "./check-no-tracker-refs.ts";
import { load as loadYaml } from "../lib/vendor/js-yaml.mjs";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../plugin/shared/guarded-git-spawn.ts";
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
// Jig's own configuration and notice, which fill the real patterns'
// placeholders: the tracker team whose keys they reject and the licensor
// whose name they reject.
const jigConfig = readFileSync(join(root, ".config/jig.yaml"), "utf8");
const { issue_tracker } = loadYaml(jigConfig) as {
  issue_tracker: { team: string };
};
const team = issue_tracker.team;
const jigNotice = readFileSync(join(root, "NOTICE"), "utf8");
const licensor =
  jigNotice
    .split("\n")
    .map((line) => /^Copyright [0-9]{4} (.+)$/.exec(line)?.[1]?.trim())
    .find((name) => name) ?? "";
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
  ["check-no-tracker-refs", "pass-tracker-allow", [".", "patterns.txt"], 0],
  [
    "check-no-tracker-refs",
    "pass-tracker-allow-exposed",
    [".", "patterns.txt"],
    0,
  ],
  [
    "check-no-tracker-refs",
    "pass-tracker-allow-context-later",
    [".", "patterns.txt"],
    0,
  ],
  [
    "check-no-tracker-refs",
    "fail-tracker-stale-allow",
    [".", "patterns.txt"],
    1,
  ],
  [
    "check-no-tracker-refs",
    "fail-tracker-allow-no-reason",
    [".", "patterns.txt"],
    1,
  ],
  ...[
    "fail-tracker-allow-beside",
    "fail-tracker-allow-duplicate",
    "fail-tracker-allow-split",
    "fail-tracker-allow-reblank",
    "fail-tracker-allow-noop",
    "fail-tracker-allow-leaves-match",
  ].map((name): [string, string, string[], number] => [
    "check-no-tracker-refs",
    name,
    [".", "patterns.txt"],
    1,
  ]),
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
  ["check-no-tracker-refs", "pass", ["./does-not-exist", trackerPatterns], 2],
  [
    "check-no-tracker-refs",
    "fail-tracker-multipattern",
    [".", "patterns.txt"],
    2,
  ],
];
// Pattern files that name configured values by placeholder. The Bash baseline
// (scripts/migration-parity.md) has no placeholders, so these cases run only
// the Bun gate.
const placeholderCases: [string, string, string[], number][] = [
  [
    "check-no-tracker-refs",
    "pass-tracker-placeholders",
    [".", "patterns.txt"],
    0,
  ],
  [
    "check-no-tracker-refs",
    "fail-tracker-placeholders",
    [".", "patterns.txt"],
    1,
  ],
  ...[
    "fail-tracker-placeholder-no-config",
    "fail-tracker-placeholder-bad-yaml",
    "fail-tracker-placeholder-no-field",
    "fail-tracker-placeholder-no-owner",
    "fail-tracker-placeholder-no-notice",
    "fail-tracker-placeholder-no-copyright",
    "fail-tracker-placeholder-no-licensor",
    "fail-tracker-placeholder-unknown",
  ].map((name): [string, string, string[], number] => [
    "check-no-tracker-refs",
    name,
    [".", "patterns.txt"],
    2,
  ]),
];
for (const [gate, fixture, args, status] of placeholderCases)
  test(`${gate}: ${fixture} exits ${status}`, () =>
    expectSpawnExit(run(gate, args, join(fixtures, fixture)), status));
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
  ["ruleset-compliant", 0],
  ["ruleset-partial", 1],
  ["ruleset-multiple", 0],
  ["ruleset-bypass-unknown", 0],
  ["classic-and-ruleset", 0],
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
  ["ruleset-compliant", "Ruleset recheck"],
  ["ruleset-compliant", "4/4 controls satisfied"],
  [
    "ruleset-compliant",
    "ruleset 7 (main; active; rules: deletion, non_fast_forward, pull_request, required_status_checks): bypass actors: app 123 (always), repository admin (always)",
  ],
  ["ruleset-partial", "FAIL  required CI status check(s) configured"],
  ["ruleset-partial", "FAIL  required conversation resolution"],
  ["ruleset-partial", "FAIL  force-push disallowed"],
  ["ruleset-partial", "PASS  branch deletion disallowed"],
  ["ruleset-partial", "bypass actors: none"],
  ["ruleset-partial", "a human adds to the branch's ruleset"],
  // Rules of one type in several rulesets add up rather than the first one winning.
  ["ruleset-multiple", "required checks: lint, gates"],
  ["ruleset-multiple", "PASS  required conversation resolution"],
  [
    "ruleset-multiple",
    "not required by policy: strict checks on, approving reviews 2",
  ],
  // Each ruleset keeps its own bypass scope and mode.
  [
    "ruleset-multiple",
    "ruleset 7 (commit hygiene; active; rules: required_status_checks, pull_request, deletion): bypass actors: repository admin (always)",
  ],
  [
    "ruleset-multiple",
    "ruleset 8 (merge gate; active; rules: required_status_checks, pull_request): bypass actors: app 123 (pull_request)",
  ],
  [
    "ruleset-multiple",
    "ruleset 9 (history; active; rules: non_fast_forward): bypass actors: none",
  ],
  // A list GitHub omitted is unknown, not empty.
  [
    "ruleset-bypass-unknown",
    "ruleset 7 (main; active; rules: deletion, non_fast_forward, pull_request, required_status_checks): bypass actors: unknown (GitHub omits them without write access to the ruleset)",
  ],
  // A ruleset beside classic protection does not hide it.
  ["classic-and-ruleset", "4/4 controls satisfied"],
  ["classic-and-ruleset", "Branch protection and ruleset recheck"],
  ["classic-and-ruleset", "administrator enforcement on"],
  [
    "classic-and-ruleset",
    "ruleset 11 (messages; active; rules: commit_message_pattern): bypass actors: none",
  ],
])
  test(`branch report includes ${needle}`, () =>
    expect(
      run("check-branch-protection", [
        "--input",
        join(fixtures, "branch-protection", `${fixture}.json`),
      ]).stdout.toString(),
    ).toContain(needle ?? ""));
test.skipIf(process.platform === "win32")(
  "a live read fails rather than reading a protected branch's unreadable classic protection as none",
  () => {
    const dir = temp();
    writeFileSync(
      join(dir, "gh"),
      `#!/bin/sh
case "$*" in
  "api --paginate --slurp repos/example/repo/rules/branches/main?per_page=100") echo '[[]]' ;;
  "api repos/example/repo/branches/main/protection") echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  "api repos/example/repo/branches/main") echo '{"protected":true}' ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
    );
    chmodSync(join(dir, "gh"), 0o755);
    const result = safeSpawn(
      [
        process.execPath,
        join(import.meta.dir, "check-branch-protection.ts"),
        "example/repo",
        "main",
      ],
      { env: { PATH: `${dir}:${process.env.PATH}` } },
    );
    expectSpawnExit(result, 2);
    expect(result.stderr.toString()).toContain(
      "cannot read the classic protection",
    );
  },
);
test("a ruleset in evaluate mode enforces nothing", () => {
  const file = join(temp(), "evaluate.json");
  writeFileSync(
    file,
    JSON.stringify({
      rules: [{ type: "deletion", ruleset_id: 7 }],
      rulesets: [{ id: 7, enforcement: "evaluate", bypass_actors: [] }],
    }),
  );
  const result = run("check-branch-protection", ["--input", file]);
  expectSpawnExit(result, 1);
  expect(result.stdout.toString()).toContain(
    "FAIL  branch deletion disallowed",
  );
});
test.each([
  ["an unknown enforcement", { enforcement: 42 }, "enforcement of ruleset 7"],
  ["a null enforcement", { enforcement: null }, "enforcement of ruleset 7"],
  ["no id", { id: undefined }, "every ruleset needs its id"],
])("a ruleset with %s is refused, not counted as active", (_, change, why) => {
  const file = join(temp(), "malformed.json");
  writeFileSync(
    file,
    JSON.stringify({
      rules: [{ type: "deletion", ruleset_id: 7 }],
      rulesets: [{ id: 7, enforcement: "active", ...change }],
    }),
  );
  const result = run("check-branch-protection", ["--input", file]);
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain(why);
});
test("a rule without the ruleset it comes from is refused", () => {
  const file = join(temp(), "orphan.json");
  writeFileSync(
    file,
    JSON.stringify({ rules: [{ type: "deletion" }], rulesets: [] }),
  );
  const result = run("check-branch-protection", ["--input", file]);
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain("ruleset_id");
});
test("a ruleset bypass list is kept per ruleset, in the offline input only under rulesets", () => {
  const file = join(temp(), "legacy.json");
  writeFileSync(file, JSON.stringify({ rules: [], bypass_actors: [] }));
  const result = run("check-branch-protection", ["--input", file]);
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain("rulesets[]");
});
// The live read, against a stand-in `gh`: POSIX only, since it is a shell script.
test.skipIf(process.platform === "win32")(
  "a live read pages through every rule, keeps classic protection out of the way and reports a missing bypass list as unknown",
  () => {
    const dir = temp();
    const pages = JSON.stringify([
      [
        {
          type: "required_status_checks",
          ruleset_id: 7,
          parameters: { required_status_checks: [{ context: "lint" }] },
        },
        {
          type: "pull_request",
          ruleset_id: 7,
          parameters: { required_review_thread_resolution: false },
        },
      ],
      [
        {
          type: "required_status_checks",
          ruleset_id: 8,
          parameters: { required_status_checks: [{ context: "gates" }] },
        },
        {
          type: "pull_request",
          ruleset_id: 8,
          parameters: { required_review_thread_resolution: true },
        },
        { type: "deletion", ruleset_id: 8 },
        { type: "non_fast_forward", ruleset_id: 8 },
      ],
    ]);
    writeFileSync(join(dir, "pages.json"), pages);
    writeFileSync(
      join(dir, "gh"),
      `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  "api --paginate --slurp repos/example/repo/rules/branches/main?per_page=100") cat "${dir}/pages.json" ;;
  "api repos/example/repo/rulesets/7") echo '{"id":7,"name":"first","enforcement":"active","bypass_actors":[]}' ;;
  "api repos/example/repo/rulesets/8") echo "HTTP 404" >&2; exit 1 ;;
  "api repos/example/repo/branches/main/protection") echo "HTTP 404: Branch not protected" >&2; exit 1 ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
    );
    chmodSync(join(dir, "gh"), 0o755);
    const result = safeSpawn(
      [
        process.execPath,
        join(import.meta.dir, "check-branch-protection.ts"),
        "example/repo",
        "main",
      ],
      { env: { PATH: `${dir}:${process.env.PATH}` } },
    );
    expectSpawnExit(result, 0);
    const out = result.stdout.toString();
    expect(out).toContain("required checks: lint, gates");
    expect(out).toContain("4/4 controls satisfied");
    expect(out).toContain(
      "ruleset 7 (first; active; rules: required_status_checks, pull_request): bypass actors: none",
    );
    expect(out).toContain(
      "ruleset 8 (rules: required_status_checks, pull_request, deletion, non_fast_forward): bypass actors: unknown",
    );
    expect(out).not.toContain("administrator enforcement");
  },
);
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
    "# Glossary\n\n- **HITL** — defined here.\n",
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
test("the glossary allowlist needs a reason per entry and fails on an entry that suppresses nothing", () => {
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  writeFileSync(
    join(dir, "GLOSSARY.md"),
    "# Glossary\n\n- **QZX** — a term.\n",
  );
  writeFileSync(join(dir, "doc.md"), "# Doc\n\nUses XQZT and QZX.\n");
  const allowlist = join(dir, "allowlist.txt");
  const args = [dir, join(dir, "GLOSSARY.md"), allowlist];
  const gate = (list: string) => {
    writeFileSync(allowlist, list);
    return run("check-glossary-coverage", args);
  };
  const green = gate("# a fixture word, not a term\nXQZT\n");
  expectSpawnExit(green, 0);
  expect(green.stdout.toString()).toContain(
    "glossary-coverage: OK — 1 Markdown files",
  );
  for (const [list, problem] of [
    ["XQZT\n", "entry 'XQZT' has no reason"],
    ["# a reason\nXQZT\n\nXQZT\n", "has no reason"],
    ["# a reason\nXQZT\nXQZT\n", "repeats an earlier entry"],
    [
      "# a reason\nXQZT\nQZX\n",
      "'QZX' suppresses nothing: GLOSSARY.md already contains it",
    ],
    [
      "# a reason\nXQZT\nZZYQ\n",
      "'ZZYQ' suppresses nothing: no checked document uses it",
    ],
  ] as const) {
    const result = gate(list);
    expectSpawnExit(result, 1);
    expect(result.stderr.toString()).toContain(problem);
  }
  rmSync(allowlist);
  expectSpawnExit(run("check-glossary-coverage", args), 2);
});

test("a glossary whose entries hold no acronym still checks", () => {
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  writeFileSync(
    join(dir, "GLOSSARY.md"),
    "# Glossary\n\n- **Drift** — disagreement between copies.\n",
  );
  writeFileSync(join(dir, "doc.md"), "# Doc\n\nOrdinary words only.\n");
  writeFileSync(join(dir, "allowlist.txt"), "");
  const args = [dir, join(dir, "GLOSSARY.md"), join(dir, "allowlist.txt")];
  expectSpawnExit(run("check-glossary-coverage", args), 0);
  writeFileSync(join(dir, "doc.md"), "# Doc\n\nUses XQZT.\n");
  const result = run("check-glossary-coverage", args);
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("undefined term of art 'XQZT'");
});

test("a glossary with acronyms but no entry could not check", () => {
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  writeFileSync(join(dir, "GLOSSARY.md"), "# Glossary\n\nQZX\n");
  writeFileSync(join(dir, "doc.md"), "# Doc\n\nUses QZX.\n");
  writeFileSync(join(dir, "allowlist.txt"), "");
  const result = run("check-glossary-coverage", [
    dir,
    join(dir, "GLOSSARY.md"),
    join(dir, "allowlist.txt"),
  ]);
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain("has no entry");
});

test("a glossary whose only entries lack a term or a definition could not check", () => {
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  writeFileSync(join(dir, "doc.md"), "# Doc\n\nOrdinary words only.\n");
  writeFileSync(join(dir, "allowlist.txt"), "");
  const args = [dir, join(dir, "GLOSSARY.md"), join(dir, "allowlist.txt")];
  for (const glossary of [
    "# Glossary\n\n- ** **\n",
    "# Glossary\n\n- ** ** — a definition without a term.\n",
    "# Glossary\n\n- **Drift** —\n",
  ]) {
    writeFileSync(join(dir, "GLOSSARY.md"), glossary);
    const result = run("check-glossary-coverage", args);
    expectSpawnExit(result, 2);
    expect(result.stderr.toString()).toContain("has no entry");
  }
  writeFileSync(
    join(dir, "GLOSSARY.md"),
    "# Glossary\n\n- **Drift** — a gap.\n",
  );
  expectSpawnExit(run("check-glossary-coverage", args), 0);
});

test("a glossary finding names the line of the term's first use outside code", () => {
  const fixture = run(
    "check-glossary-coverage",
    [".", "GLOSSARY.md", "allowlist.txt"],
    join(fixtures, "fail-glossary"),
  );
  expectSpawnExit(fixture, 1);
  expect(fixture.stderr.toString()).toContain(
    "doc.md:3: [glossary-coverage] undefined term of art 'XQZT'",
  );
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  writeFileSync(
    join(dir, "GLOSSARY.md"),
    "# Glossary\n\n- **QZX** — a term.\n",
  );
  writeFileSync(
    join(dir, "doc.md"),
    "# Doc\n\n```\nXQZT in a fence\n```\n\nInline `XQZT\ncode` spans lines.\nNow XQZT in prose.\n",
  );
  writeFileSync(join(dir, "allowlist.txt"), "");
  const result = run("check-glossary-coverage", [
    dir,
    join(dir, "GLOSSARY.md"),
    join(dir, "allowlist.txt"),
  ]);
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain(
    "doc.md:9: [glossary-coverage] undefined term of art 'XQZT'",
  );
});

test("a tracker reference hidden by blanking only its context is still reported", () => {
  // The alternative fixture's first allow leaves the name's own pattern
  // matching over the hidden name, which does not stand in for it; both allows
  // exempt that other match, so both are in use.
  for (const [fixture, line, unused, live] of [
    ["fail-tracker-allow-context", 4, [7], [5]],
    ["fail-tracker-allow-context-alternative", 3, [], [6, 8]],
  ] as const) {
    const result = run(
      "check-no-tracker-refs",
      [".", "patterns.txt"],
      join(fixtures, fixture),
    );
    expectSpawnExit(result, 1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      `allowed.md:${line}: [no-origin-references] origin reference \`acme\``,
    );
    for (const allow of unused)
      expect(stderr).toContain(
        `patterns.txt:${allow}: [origin-reference-allowlist] allow pattern exempts nothing`,
      );
    for (const allow of live)
      expect(stderr).not.toContain(`patterns.txt:${allow}:`);
  }
});

test("a tracker reference found again on an exempted span is reported", () => {
  const result = run(
    "check-no-tracker-refs",
    [".", "patterns.txt"],
    join(fixtures, "fail-tracker-allow-reappears"),
  );
  expectSpawnExit(result, 1);
  const stderr = result.stderr.toString();
  expect(stderr).toContain(
    "allowed.md:3: [no-origin-references] origin reference `a  `",
  );
  expect(stderr).not.toContain("[origin-reference-allowlist]");
});

test("a tracker allow pattern is in use only when it removes a reference the earlier patterns left", () => {
  for (const [fixture, line] of [
    ["fail-tracker-allow-beside", 7],
    ["fail-tracker-allow-duplicate", 8],
    ["fail-tracker-allow-split", 7],
    ["fail-tracker-allow-reblank", 7],
    ["fail-tracker-allow-noop", 7],
    ["fail-tracker-allow-leaves-match", 7],
  ] as const) {
    const result = run(
      "check-no-tracker-refs",
      [".", "patterns.txt"],
      join(fixtures, fixture),
    );
    expectSpawnExit(result, 1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      `patterns.txt:${line}: [origin-reference-allowlist] allow pattern exempts nothing`,
    );
    expect(stderr).not.toContain("patterns.txt:5:");
    expect(stderr).not.toContain("[no-origin-references]");
  }
});

test("a Markdown gate with no Markdown file to read could not check", () => {
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  writeFileSync(join(dir, "notes.txt"), "not Markdown\n");
  for (const gate of [
    "check-md-links",
    "check-md-tables",
    "check-instruction-paths",
  ]) {
    const result = run(gate, [dir]);
    expectSpawnExit(result, 2);
    expect(result.stderr.toString()).toContain("could not check");
  }
  // A glossary with a real term and a valid allowlist, so the missing
  // Markdown alone decides the outcome.
  writeFileSync(
    join(dir, "GLOSSARY.md"),
    "# Glossary\n\n- **QZX** — a term.\n",
  );
  writeFileSync(join(dir, "allowlist.txt"), "");
  const glossary = run("check-glossary-coverage", [
    dir,
    join(dir, "GLOSSARY.md"),
    join(dir, "allowlist.txt"),
  ]);
  expectSpawnExit(glossary, 2);
  expect(glossary.stderr.toString()).toContain(
    "could not check: no Markdown file",
  );
});

test("a Markdown finding names its rule, place and fix, and is annotated under GitHub Actions", () => {
  const result = safeSpawn(
    [process.execPath, join(import.meta.dir, "check-md-tables.ts"), "."],
    { cwd: join(fixtures, "fail-table"), env: { GITHUB_ACTIONS: "true" } },
  );
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toMatch(
    /bad\.md:\d+: \[md-table-blank-line\] table not preceded by a blank line\n {2}fix: /,
  );
  expect(result.stdout.toString()).toMatch(
    /^::error file=bad\.md,line=\d+,title=md-table-blank-line::/m,
  );
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
    mkdirSync(join(dir, ".config"));
    writeFileSync(join(dir, ".config/jig.yaml"), jigConfig);
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked/notes.md"), `See ${team}-1 for why.\n`);
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
  // The licensor's name as NOTICE writes it, and as an address spells it.
  const name = licensor;
  const lower = name.toLowerCase();
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
    expectSpawnExit(safeSpawn(["git", "-C", dir, "add", path]), 0);
  };
  const check = () => run("check-no-tracker-refs", [dir]);
  // History keeps the address the repository had.
  write(
    "CHANGELOG.md",
    [
      `- the repository moves to \`https://github.com/${lower}/jig\`;`,
      `Install from https://github.com/${lower}/jig.git`,
      `See https://github.com/${lower}/jig/blob/main/README.md`,
      `Hosted at https://github.com/${lower}/jig.`,
      `[1.0.0]: https://github.com/${lower}/jig/compare/v0.9.0...v1.0.0`,
      "",
    ].join("\n"),
  );
  write("NOTICE", jigNotice);
  write("plugin/NOTICE", jigNotice);
  write("LICENSE-MIT-0", `MIT No Attribution\n\nCopyright 2026 ${name}\n`);
  write(
    "plugin/.claude-plugin/plugin.json",
    `{\n  "author": { "name": "${name}" }\n}\n`,
  );
  write(
    ".claude-plugin/marketplace.json",
    `{\n  "owner": { "name": "${name}" }\n}\n`,
  );
  write(".config/jig.yaml", jigConfig);
  // The record of who holds the copyright names the licensor.
  write(
    "docs/adr/ADR-0006-home-copyright-and-brand-held-apart.md",
    `**Deciders:** Jig's maintainer and ${name}\n\n${name} holds the copyright.\n`,
  );
  // A word that only starts or ends like the team key is not a key.
  const key = team.toLowerCase();
  write("words.md", `${key}s2024, ${key}12, x${key}1234, ${team}-ish\n`);
  expectSpawnExit(check(), 0);
  for (const content of [
    `See ${team}-1234.\n`,
    // The key folded into a name.
    `git switch -c user/${key}-1234-title\n`,
    `makeWorktree("${key}1234-main");\n`,
    `const PRE_${team}_1234_ACCOUNT = 1;\n`,
    `join(tmpRoot, "no-such-binary-${key}1234");\n`,
    // A short key is still a key once a separator sets it apart.
    `git switch -c feature/${key}-42-fix\n`,
    `const PRE_${team}_42_ACCOUNT = 1;\n`,
    `makeWorktree("${key}_7");\n`,
    `Built at ${name}.\n`,
    `export const STATE = "~/.${lower}/state";\n`,
    `See https://github.com/${lower}/other-repo.\n`,
    // The earlier address is history, which only the changelog records.
    `Install from https://github.com/${lower}/jig.git\n`,
    `See https://github.com/${lower}/jig/blob/main/README.md\n`,
    // A copyright line outside the licence files.
    `Copyright 2026 ${name}\n`,
  ]) {
    write("notes.md", content);
    expectSpawnExit(check(), 1);
  }
  write("notes.md", "Nothing to see.\n");
  expectSpawnExit(check(), 0);
  // Only that record may name the licensor; another decision record may not.
  write("docs/adr/ADR-0007-another.md", `Agreed with ${name}.\n`);
  const another = check();
  expectSpawnExit(another, 1);
  expect(another.stderr.toString()).toContain("docs/adr/ADR-0007-another.md");
  write("docs/adr/ADR-0007-another.md", "Agreed.\n");
  expectSpawnExit(check(), 0);
  for (const content of [
    // The exemption ends at the repository name, not at a word boundary.
    `See https://github.com/${lower}/jig-other.\n`,
    `See https://github.com/${lower}/jig.github.io.\n`,
    `See https://github.com/${lower}/jig_x.\n`,
    `See https://github.com/${lower}/jig..private.\n`,
    // The exemption starts at the whole address, not inside another host.
    `See https://notgithub.com/${lower}/jig.\n`,
    `See https://evil.github.com/${lower}/jig.\n`,
    // An allowed occurrence exempts itself, not the line it sits on.
    `https://github.com/${lower}/jig, built at ${name}.\n`,
    `Built at ${name}: https://github.com/${lower}/jig.\n`,
  ]) {
    write("CHANGELOG.md", content);
    expectSpawnExit(check(), 1);
  }
  write("CHANGELOG.md", `See https://github.com/${lower}/jig.\n`);
  for (const content of [
    `{\n  "author": { "name": "${name}" }, "see": "${team}-1"\n}\n`,
    `{\n  "homepage": "${name}"\n}\n`,
  ]) {
    write("plugin/.claude-plugin/plugin.json", content);
    expectSpawnExit(check(), 1);
  }
});

test("placeholders are filled from the configuration, and an unfilled one names its field and file", () => {
  const caught = run(
    "check-no-tracker-refs",
    [".", "patterns.txt"],
    join(fixtures, "fail-tracker-placeholders"),
  );
  expectSpawnExit(caught, 1);
  expect(caught.stderr.toString()).toContain("`ENG-42`");
  for (const [fixture, needles] of [
    ["fail-tracker-placeholder-no-config", [".config/jig.yaml", "ENOENT"]],
    ["fail-tracker-placeholder-bad-yaml", [".config/jig.yaml", "YAML"]],
    [
      "fail-tracker-placeholder-no-field",
      ["patterns.txt:2", "issue_tracker.team", ".config/jig.yaml"],
    ],
    [
      "fail-tracker-placeholder-no-owner",
      ["patterns.txt:2", "review.repo_slug", "owner/name", ".config/jig.yaml"],
    ],
    [
      "fail-tracker-placeholder-no-notice",
      ["patterns.txt:2", "{{licensor}}", "NOTICE", "ENOENT"],
    ],
    [
      "fail-tracker-placeholder-no-copyright",
      ["patterns.txt:2", "{{licensor}}", "Copyright <year> <name>", "NOTICE"],
    ],
    [
      "fail-tracker-placeholder-no-licensor",
      [
        "patterns.txt:2",
        "{{licensor}}",
        "name on the copyright line",
        "NOTICE",
      ],
    ],
    ["fail-tracker-placeholder-unknown", ["patterns.txt:2", "{{project}}"]],
  ] as const) {
    const result = run(
      "check-no-tracker-refs",
      [".", "patterns.txt"],
      join(fixtures, fixture),
    );
    expectSpawnExit(result, 2);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("could not check");
    for (const needle of needles) expect(stderr).toContain(needle);
  }
});

test("the configuration and notice that fill the real patterns still name the original team and licensor", () => {
  // The real patterns reject whatever `.config/jig.yaml` and NOTICE name,
  // and those lines are exempt from the gate. A changed team or licensor
  // would silently stop the gate rejecting the original ones, so both are
  // pinned here by digest, which checks them without spelling them out.
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  expect(digest(team)).toBe(
    "c9ff9d7d29e892ae070c1d1c994458bff733dfad5f006865c3c7065193f789db",
  );
  expect(digest(licensor)).toBe(
    "15c20ce075903fe982cc794293785f040317201bc28c08f769933bcb0094e109",
  );
});

test("a filled value is matched literally, not as a regular expression", () => {
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
    expectSpawnExit(safeSpawn(["git", "-C", dir, "add", path]), 0);
  };
  write(".config/jig.yaml", "issue_tracker:\n  team: A.B\n");
  write("patterns.txt", "\\b{{team}}-[0-9]+\\b\n");
  const check = () =>
    run("check-no-tracker-refs", [dir, join(dir, "patterns.txt")]);
  write("notes.md", "See AxB-12.\n");
  expectSpawnExit(check(), 0);
  write("notes.md", "See A.B-12.\n");
  expectSpawnExit(check(), 1);
});

test("the real pattern file, which the gate skips, holds nothing its own patterns reject", () => {
  const { regexes } = readPatterns(
    join(import.meta.dir, "tracker-key-patterns.txt"),
    root,
  );
  const leaks = readFileSync(
    join(import.meta.dir, "tracker-key-patterns.txt"),
    "utf8",
  )
    .split("\n")
    .flatMap((line, index) =>
      regexes.some((regex) => regex.test(line))
        ? [`${index + 1}: ${line}`]
        : [],
    );
  expect(leaks).toEqual([]);
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
  // Bun replaces the configured ignore list, so it must be passed along.
  expect(testArgs(["suite/**"], ["**/fixtures/**"])).toEqual([
    "run",
    "test",
    "--path-ignore-patterns=**/fixtures/**",
    "--path-ignore-patterns=suite/**",
  ]);
});

test("the gate set runs its cheap stages first and --fast runs only those", async () => {
  const { plan, CHECKS, heavyStages, testStage } = await import("./gates.ts");
  const test = testStage(["suite/**"], () => []);
  const full = plan(false, test).map((stage) => stage.name);
  const fast = plan(true, test).map((stage) => stage.name);
  // The pre-push hook's fast set: the context budget, format, lint, types
  // and the toolchain pins, then every repository check, and nothing that
  // takes minutes.
  expect(fast).toEqual([
    "bun scripts/check-context-budget.ts",
    "bun run format:check",
    "bun run lint",
    "bun run typecheck",
    "bun run pins",
    ...CHECKS.map((stage) => stage.name),
  ]);
  // The full set is the fast set followed by the heavy stages, so every
  // repository check reports before the first of them starts.
  const heavy = heavyStages(test).map((stage) => stage.name);
  expect(heavy).toEqual([
    "bun run deadcode",
    "bun run audit",
    "bun run quality",
    "bun run test '--path-ignore-patterns=suite/**'",
    "bun run build",
  ]);
  expect(full).toEqual([...fast, ...heavy]);
  // The repository checks, stated here rather than read back from CHECKS:
  // the lockstep gate first, judging install scripts before anything else.
  expect(CHECKS.map((stage) => stage.name)).toEqual([
    "bun scripts/check-supply-chain-lockstep.ts",
    "bun scripts/check-md-links.ts",
    "bun scripts/check-instruction-paths.ts",
    "bun scripts/check-md-tables.ts",
    "bun scripts/check-glossary-coverage.ts",
    "bun scripts/check-no-tracker-refs.ts",
    "bun scripts/check-licences.ts",
    "bun scripts/check-workflow-safety.ts",
    "bun scripts/check-workflow-conventions.ts",
    "bun scripts/check-schedules-declared.ts",
    "bun scripts/check-changelog.ts",
    "bun scripts/check-audit-fit.ts",
    "bun scripts/change-areas.ts --check",
    "bun scripts/check-generated-files.ts",
    "bun scripts/review-risk.ts --check",
    "bun scripts/check-roadmap.ts",
  ]);
});

test.skipIf(process.platform === "win32")(
  "a stage's name is a command a shell runs as it is",
  async () => {
    const { heavyStages, shellWord, testStage } = await import("./gates.ts");
    expect(shellWord("run")).toBe("run");
    expect(shellWord("--path-ignore-patterns=**/fixtures/**")).toBe(
      "'--path-ignore-patterns=**/fixtures/**'",
    );
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
    // The test stage's name, pasted into a shell, hands bun the same arguments.
    const args = [
      "run",
      "test",
      "--path-ignore-patterns=**/fixtures/**",
      "--path-ignore-patterns=a b",
    ];
    const stage = heavyStages(
      testStage(["a b"], () => ["**/fixtures/**"]),
    ).find((s) => s.name.startsWith("bun run test "));
    if (stage === undefined) throw new Error("no test stage");
    const echoed = Bun.spawnSync(
      [
        "sh",
        "-c",
        `set -- ${stage.name.replace(/^bun /, "")}; printf '%s\\n' "$@"`,
      ],
      { cwd: root, stdout: "pipe" },
    );
    expect(echoed.stdout.toString().trimEnd().split("\n")).toEqual(args);
  },
);

test("a failing stage does not end the run: every stage reports and the run lists what failed", async () => {
  const { runStages, summary, verdict } = await import("./gates.ts");
  const ran: string[] = [];
  const stage = (name: string, status: number) => ({
    name,
    check: (seen: string) => {
      expect(seen).toBe(root);
      ran.push(name);
      return status;
    },
  });
  const outcomes = await runStages(
    [
      stage("first violation", 1),
      // A command's status is its exit code; it runs for real.
      { name: "command", command: ["-e", "process.exit(1)"] },
      {
        name: "throws",
        check: () => {
          ran.push("throws");
          throw new Error("unreadable input");
        },
      },
      stage("could not check", 2),
      stage("last and green", 0),
    ],
    root,
  );
  // A command that cannot be started could not check, and the run goes on.
  const unstartable = await runStages(
    [
      { name: "cannot start", command: ["-e", "0"] },
      { name: "after it", check: () => 0 },
    ],
    join(root, "no-such-directory"),
  );
  expect(unstartable).toEqual([
    { name: "cannot start", status: 2 },
    { name: "after it", status: 0 },
  ]);
  expect(ran).toEqual([
    "first violation",
    "throws",
    "could not check",
    "last and green",
  ]);
  expect(outcomes).toEqual([
    { name: "first violation", status: 1 },
    { name: "command", status: 1 },
    { name: "throws", status: 2 },
    { name: "could not check", status: 2 },
    { name: "last and green", status: 0 },
  ]);
  // Found violations outranks could not check; the closing report names
  // every failed stage with its status and leaves the green ones out.
  expect(verdict(outcomes)).toBe(1);
  expect(summary(outcomes, false)).toBe(
    [
      "gates: 4 of 5 stages failed",
      "  first violation  # exit 1",
      "  command  # exit 1",
      "  throws  # exit 2",
      "  could not check  # exit 2",
    ].join("\n"),
  );
  // Only could-not-check failures: the run itself could not decide.
  const undecided = [
    { name: "a", status: 0 },
    { name: "b", status: 2 },
  ];
  expect(verdict(undecided)).toBe(2);
  expect(summary(undecided, true)).toBe(
    "gates: 1 of 2 stages failed\n  b  # exit 2",
  );
  // Green: the pass line says which set ran.
  const green = [{ name: "a", status: 0 }];
  expect(verdict(green)).toBe(0);
  expect(summary(green, true)).toBe("fast gates passed");
  expect(summary(green, false)).toBe("all gates passed");
  // No stage at all is not a pass.
  expect(verdict([])).toBe(2);
  expect(summary([], false)).toBe("gates: could not check: no stage ran");
});

test("an unreadable test configuration fails the test stage alone", async () => {
  const { runStages, testStage } = await import("./gates.ts");
  let reads = 0;
  const unreadable = () => {
    reads++;
    throw new Error("bunfig.toml is not TOML");
  };
  // Nothing is read when no suite is skipped, as under --fast.
  expect(testStage([], unreadable)).toMatchObject({
    name: "bun run test",
    command: ["run", "test"],
  });
  expect(reads).toBe(0);
  const stage = testStage(["suite/**"], unreadable);
  expect(stage.name).toBe("bun run test");
  const outcomes = await runStages(
    [
      { name: "before", check: () => 0 },
      stage,
      { name: "after", check: () => 0 },
    ],
    root,
  );
  expect(outcomes).toEqual([
    { name: "before", status: 0 },
    { name: "bun run test", status: 2 },
    { name: "after", status: 0 },
  ]);
});

test.skipIf(process.platform === "win32")(
  "a failed stage's closing line, pasted whole, reruns its command",
  async () => {
    const { summary } = await import("./gates.ts");
    const line = summary([{ name: "bun run lint", status: 1 }], true)
      .split("\n")
      .at(-1);
    if (line === undefined) throw new Error("no closing line");
    // The arguments a shell hands bun when the whole line is pasted.
    const echoed = Bun.spawnSync(
      [
        "sh",
        "-c",
        `set -- ${line.replace(/^ *bun /, "")}\nprintf '%s\\n' "$@"`,
      ],
      { cwd: root, stdout: "pipe" },
    );
    expect(echoed.stdout.toString().trimEnd().split("\n")).toEqual([
      "run",
      "lint",
    ]);
  },
);

type SuiteJob = {
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  strategy?: { matrix?: Record<string, unknown> } & Record<string, unknown>;
  steps?: ({ if?: string; run?: string } & Record<string, unknown>)[];
} & Record<string, unknown>;

// Whether a job runs and whether its failure reaches the run's result are set
// by its condition and its dependencies: a skipped dependency skips the job.
// A suite that runs as steps of a larger job carries its own step condition.
type SuiteContract = { if?: string; needs?: string; stepIf?: string };

// A job counts as running a suite only when every key of its workflow, every
// key it carries, every key of its strategy and every key of the suite's step
// is on an allowlist — every scope whose settings a step inherits — and
// the keys that decide whether it runs hold exactly the values the workflow
// intends. An allowlist rather than a list of rejected keys, because each key
// GitHub adds or a workflow uses that this check does not know — a job- or
// step-level `continue-on-error`, a workflow- or job-level `defaults` shell,
// a `container`, an `env`
// a test runner reads — is one more way to keep the job green while the suite
// does not run or its failures are suppressed. The condition and the
// dependencies must equal the contract; the matrix may hold nothing but the
// shard list, so no include, exclude or extra dimension can change which jobs
// run. The suite's step carries a name and a command and nothing else (and
// the contract's step condition, exactly, where it has one), and its
// whole command must be one of two shapes: the suite's directory alone, or
// every shard of it. Any other text — an extra option such as a test-name
// filter, shell syntax, a fixed shard — does not count, because nothing
// proves it still runs every test in the directory. A sharded command must
// take its shard from the job's matrix, and the matrix must list every shard
// from 1 to the command's total.
//
// The check reads the workflow's settings, not what its commands do: an
// earlier step that puts another `bun` first on the PATH or deletes the
// suite's directory changes what the suite step runs without changing a key
// read here. Such a step is a deliberate edit to the workflow's commands, and
// review of the workflow catches it, as it does any other change to them.
const SUITE_WORKFLOW_KEYS = new Set([
  "name",
  "on",
  "permissions",
  "concurrency",
  "jobs",
]);
const SUITE_JOB_KEYS = new Set([
  "name",
  "needs",
  "if",
  "strategy",
  "runs-on",
  "timeout-minutes",
  "steps",
]);
const SUITE_STRATEGY_KEYS = new Set(["fail-fast", "matrix"]);
const SUITE_STEP_KEYS = new Set(["name", "run"]);

const onlyKeys = (value: object, allowed: Set<string>) =>
  Object.keys(value).every((key) => allowed.has(key));

function suiteJobShapeAllowed(job: SuiteJob, contract: SuiteContract) {
  if (!onlyKeys(job, SUITE_JOB_KEYS)) return false;
  if (job.if !== contract.if || job.needs !== contract.needs) return false;
  const strategy = job.strategy;
  if (strategy === undefined) return true;
  if (!onlyKeys(strategy, SUITE_STRATEGY_KEYS)) return false;
  const matrix = strategy.matrix;
  return (
    matrix === undefined ||
    (Object.keys(matrix).length === 1 &&
      ("shard" in matrix || "include" in matrix))
  );
}

/**
 * The `os` values a job's `matrix.include` runs on. The job runs on each row's
 * `runner`, not its `os`, so a row counts only when its runner names that
 * platform (`blacksmith-6vcpu-macos-latest` for `macos`).
 */
function matrixPlatforms(job: SuiteJob): string[] {
  const include = job.strategy?.matrix?.include;
  if (!Array.isArray(include) || job["runs-on"] !== `\${{ matrix.runner }}`)
    return [];
  return include.flatMap((row: Record<string, unknown>) =>
    typeof row.os === "string" &&
    typeof row.runner === "string" &&
    row.runner.split("-").includes(row.os)
      ? [row.os]
      : [],
  );
}

function runsEveryShard(run: string, dir: string, shards: unknown): boolean {
  const sharded = run.match(
    new RegExp(
      `^bun run test --shard=\\$\\{\\{ matrix\\.shard \\}\\}/([1-9][0-9]*) \\./${dir.replace(/[.]/g, "\\.")}$`,
    ),
  );
  if (!sharded) return false;
  const total = Number(sharded[1]);
  return (
    Array.isArray(shards) &&
    shards.length === total &&
    shards.every((shard, i) => shard === i + 1)
  );
}

function runsSuite(job: SuiteJob, dir: string, contract: SuiteContract = {}) {
  if (!suiteJobShapeAllowed(job, contract)) return false;
  const shards = job.strategy?.matrix?.shard;
  const stepKeys =
    contract.stepIf === undefined
      ? SUITE_STEP_KEYS
      : new Set([...SUITE_STEP_KEYS, "if"]);
  return (job.steps ?? []).some(
    (step) =>
      onlyKeys(step, stepKeys) &&
      step.if === contract.stepIf &&
      typeof step.run === "string" &&
      (step.run.trim() === `bun run test ./${dir}` ||
        runsEveryShard(step.run.trim(), dir, shards)),
  );
}

type SuiteWorkflow = { jobs?: Record<string, SuiteJob> } & Record<
  string,
  unknown
>;

// Whether a workflow runs at all is set by its triggers, so they must equal
// the workflow's intended ones exactly: a dropped schedule or a path filter
// on a pull request trigger stops the suite running with every job intact.
type WorkflowContract = SuiteContract & { on: unknown };

function workflowRunsSuite(
  workflow: SuiteWorkflow,
  job: string,
  dir: string,
  contract: WorkflowContract,
) {
  return (
    onlyKeys(workflow, SUITE_WORKFLOW_KEYS) &&
    Bun.deepEquals(workflow.on, contract.on, true) &&
    runsSuite(workflow.jobs?.[job] ?? {}, dir, contract)
  );
}

// On pull requests the drive-pr suite runs when its area is affected and the
// CI hold is off, after the job that resolves the areas; every night it runs
// unconditionally. The website's suite runs in the gate-set job, which runs
// whenever the hold is off, as a step selected by the website area.
const DRIVE_PR_AREA = `contains(needs.areas.outputs.areas, '"drive-pr"')`;
const NOT_HELD = `!contains(github.event.pull_request.labels.*.name, 'ci:hold')`;
const PR_SUITE: SuiteContract = {
  needs: "areas",
  if: `\${{ ${DRIVE_PR_AREA} && ${NOT_HELD} }}`,
};
const WEBSITE_STEP = `\${{ !cancelled() && contains(needs.areas.outputs.areas, '"website"') }}`;
const PR_WEBSITE_SUITE: SuiteContract = {
  needs: "areas",
  if: `\${{ ${NOT_HELD} }}`,
  stepIf: WEBSITE_STEP,
};
// Pull requests list the hold label's events beside the default types.
const PR_TRIGGERS = {
  pull_request: {
    types: ["opened", "synchronize", "reopened", "labeled", "unlabeled"],
  },
  push: { branches: ["main"] },
};
const NIGHTLY_TRIGGERS = {
  schedule: [{ cron: "17 3 * * *" }],
  workflow_dispatch: null,
};

test("a suite counts as run only by an allowlisted job and command", async () => {
  const { SEPARATE_SUITES } = await import("./gates.ts");
  for (const suite of SEPARATE_SUITES) {
    const dir = suite.replace(/\*\*$/, "");
    const sharded = `bun run test --shard=\${{ matrix.shard }}/4 ./${dir}`;
    const all = { strategy: { matrix: { shard: [1, 2, 3, 4] } } };
    expect(runsSuite({ steps: [{ run: `bun run test ./${dir}` }] }, dir)).toBe(
      true,
    );
    expect(runsSuite({ ...all, steps: [{ run: sharded }] }, dir)).toBe(true);
    for (const run of [
      `echo ./${dir}`,
      `bun run test ./scripts/ # ./${dir}`,
      `bun run test ./scripts/; echo ./${dir}`,
      `bun run test ./scripts/ && echo ./${dir}`,
      `bun run test ./scripts/\necho ./${dir}`,
      `bun run test "./scripts/" ./${dir}`,
      `bun run test --test-name-pattern=NOTHING ./${dir}`,
      `bun run test ./${dir} ./scripts/`,
      `bun run test --shard=1/4 ./${dir}`,
    ])
      expect(runsSuite({ ...all, steps: [{ run }] }, dir)).toBe(false);
    for (const shard of [[1], [1, 2, 3], [1, 2, 3, 3], [2, 3, 4, 5], "1"])
      expect(
        runsSuite(
          { strategy: { matrix: { shard } }, steps: [{ run: sharded }] },
          dir,
        ),
      ).toBe(false);
    expect(
      runsSuite({ ...all, steps: [{ if: "always()", run: sharded }] }, dir),
    ).toBe(false);
    // A job condition or dependencies other than the intended ones, or a
    // matrix that can drop or add combinations, does not count either.
    expect(
      runsSuite({ ...all, steps: [{ run: sharded }] }, dir, PR_SUITE),
    ).toBe(false);
    expect(
      runsSuite(
        { ...all, if: DRIVE_PR_AREA, steps: [{ run: sharded }] },
        dir,
        PR_SUITE,
      ),
    ).toBe(false);
    expect(
      runsSuite(
        { ...all, ...PR_SUITE, steps: [{ run: sharded }] },
        dir,
        PR_SUITE,
      ),
    ).toBe(true);
    for (const condition of ["false", `${DRIVE_PR_AREA} && false`])
      expect(
        runsSuite(
          { ...all, ...PR_SUITE, if: condition, steps: [{ run: sharded }] },
          dir,
          PR_SUITE,
        ),
      ).toBe(false);
    // A dependency that can be skipped skips the suite with it.
    for (const needs of ["skipped-job", ["areas", "skipped-job"], ["areas"]])
      expect(
        runsSuite(
          { ...all, ...PR_SUITE, needs, steps: [{ run: sharded }] },
          dir,
          PR_SUITE,
        ),
      ).toBe(false);
    expect(
      runsSuite(
        { ...all, needs: "skipped-job", steps: [{ run: sharded }] },
        dir,
      ),
    ).toBe(false);
    expect(
      runsSuite({ ...all, if: "false", steps: [{ run: sharded }] }, dir),
    ).toBe(false);
    for (const extra of [
      { exclude: [{ shard: 4 }] },
      { include: [{ shard: 5 }] },
      { os: ["linux"] },
    ])
      expect(
        runsSuite(
          {
            strategy: { matrix: { shard: [1, 2, 3, 4], ...extra } },
            steps: [{ run: sharded }],
          },
          dir,
        ),
      ).toBe(false);
    // Any key outside the allowlist does not count, whether on the job, its
    // strategy or the suite's step: each is a way to keep the job green while
    // the suite's failures are suppressed or it runs something else.
    for (const extra of [
      { "continue-on-error": true },
      { defaults: { run: { shell: "bash {0} || true" } } },
      { env: { BUN_OPTIONS: "--bail" } },
      { container: "alpine" },
    ])
      expect(
        runsSuite({ ...all, ...extra, steps: [{ run: sharded }] }, dir),
      ).toBe(false);
    expect(
      runsSuite(
        {
          strategy: { ...all.strategy, "max-parallel": 1, extra: true },
          steps: [{ run: sharded }],
        },
        dir,
      ),
    ).toBe(false);
    for (const extra of [
      { "continue-on-error": true },
      { shell: "bash {0} || true" },
      { env: { BUN_OPTIONS: "--bail" } },
      { "working-directory": "plugin" },
    ])
      expect(
        runsSuite({ ...all, steps: [{ ...extra, run: sharded }] }, dir),
      ).toBe(false);
    expect(
      runsSuite(
        {
          ...all,
          name: "suite",
          "runs-on": "linux",
          "timeout-minutes": 15,
          steps: [{ name: "Run the suite", run: sharded }],
        },
        dir,
      ),
    ).toBe(true);
  }
});

test("a suite's step condition counts only where the contract names it, and only that one", () => {
  const dir = "website/";
  const run = `bun run test ./${dir}`;
  const stepIf = WEBSITE_STEP;
  expect(runsSuite({ steps: [{ if: stepIf, run }] }, dir, { stepIf })).toBe(
    true,
  );
  expect(runsSuite({ steps: [{ if: stepIf, run }] }, dir)).toBe(false);
  for (const step of [
    { run },
    { if: "always()", run },
    { if: `${stepIf} || true`, run },
  ])
    expect(runsSuite({ steps: [step] }, dir, { stepIf })).toBe(false);
});

// The same holds one scope up: a workflow-level setting reaches every step of
// every job.
test("a suite counts as run only in an allowlisted workflow", async () => {
  const { SEPARATE_SUITES } = await import("./gates.ts");
  for (const suite of SEPARATE_SUITES) {
    const dir = suite.replace(/\*\*$/, "");
    const sharded = `bun run test --shard=\${{ matrix.shard }}/4 ./${dir}`;
    const all = { strategy: { matrix: { shard: [1, 2, 3, 4] } } };
    const workflow = {
      name: "nightly",
      on: NIGHTLY_TRIGGERS,
      permissions: { contents: "read" },
      concurrency: { group: "nightly", "cancel-in-progress": true },
      jobs: { suite: { ...all, steps: [{ run: sharded }] } },
    };
    const nightly = { on: NIGHTLY_TRIGGERS };
    expect(workflowRunsSuite(workflow, "suite", dir, nightly)).toBe(true);
    expect(workflowRunsSuite(workflow, "other", dir, nightly)).toBe(false);
    for (const extra of [
      { defaults: { run: { shell: 'bash -c "exit 0" {0}' } } },
      { env: { BASH_ENV: "/dev/null" } },
    ])
      expect(
        workflowRunsSuite({ ...workflow, ...extra }, "suite", dir, nightly),
      ).toBe(false);
    // Triggers other than the intended ones do not count: a nightly run
    // without its schedule, or a pull request trigger narrowed by paths.
    for (const [on, intended] of [
      [{ workflow_dispatch: null }, NIGHTLY_TRIGGERS],
      [{ ...NIGHTLY_TRIGGERS, schedule: [] }, NIGHTLY_TRIGGERS],
      [PR_TRIGGERS, NIGHTLY_TRIGGERS],
      [{ ...PR_TRIGGERS, pull_request: { paths: ["docs/**"] } }, PR_TRIGGERS],
      [{ pull_request: null }, PR_TRIGGERS],
    ] as const)
      expect(
        workflowRunsSuite({ ...workflow, on }, "suite", dir, { on: intended }),
      ).toBe(false);
    expect(
      workflowRunsSuite({ ...workflow, on: PR_TRIGGERS }, "suite", dir, {
        on: PR_TRIGGERS,
      }),
    ).toBe(true);
  }
});

/**
 * The job that runs a separate suite and the contract it runs it under. On
 * pull requests the website's suite runs as steps of the gate job itself.
 */
function suiteRunner(
  workflow: string,
  gateJob: string,
  suite: string,
  on: unknown,
): [string, WorkflowContract] {
  const website = suite === "website/**";
  if (workflow !== "gates.yml")
    return [website ? "website" : "drive-pr-suite", { on }];
  return website
    ? [gateJob, { ...PR_WEBSITE_SUITE, on }]
    : ["drive-pr-suite", { ...PR_SUITE, on }];
}

/** Whether the gate job, or its step running the gate set, skips the separate suites. */
function skipsSeparate(job: SuiteJob | undefined, env: string): boolean {
  return (
    job?.env?.[env] === "1" ||
    (job?.steps ?? []).some(
      (step) =>
        step.run === "bun run gates" &&
        (step.env as Record<string, string> | undefined)?.[env] === "1",
    )
  );
}

test("every suite the gate job leaves out runs in a CI job of its own or a selected step", async () => {
  const { SEPARATE_SUITES, SKIP_SEPARATE_ENV } = await import("./gates.ts");
  const { load } = await import("js-yaml");
  const read = (name: string) =>
    load(
      readFileSync(join(root, ".github/workflows", name), "utf8"),
    ) as SuiteWorkflow & { jobs: Record<string, SuiteJob> };
  // Pull requests run the gate set on Linux; the nightly run covers macOS
  // and Windows. Each workflow's gate job leaves the separate suites to its
  // own suite jobs, or on pull requests the website's to its own steps.
  for (const [name, gateJob, on] of [
    ["gates.yml", "gate-set", PR_TRIGGERS],
    ["nightly.yml", "platform-gates", NIGHTLY_TRIGGERS],
  ] as const) {
    const workflow = read(name);
    expect(skipsSeparate(workflow.jobs[gateJob], SKIP_SEPARATE_ENV)).toBe(true);
    for (const suite of SEPARATE_SUITES) {
      const [job, suiteContract] = suiteRunner(name, gateJob, suite, on);
      expect(
        workflowRunsSuite(
          workflow,
          job,
          suite.replace(/\*\*$/, ""),
          suiteContract,
        ),
      ).toBe(true);
    }
  }
  // The nightly run stands in for macOS and Windows, so a separate suite that
  // is not POSIX-only runs there on both.
  const { POSIX_ONLY_SUITES } = await import("./gates.ts");
  const nightly = read("nightly.yml");
  for (const suite of SEPARATE_SUITES.filter(
    (s) => !POSIX_ONLY_SUITES.includes(s),
  )) {
    const job = suite === "website/**" ? "website" : "drive-pr-suite";
    expect(matrixPlatforms(nightly.jobs[job] ?? {}).sort()).toEqual([
      "macos",
      "windows",
    ]);
  }
  const { jobs } = read("gates.yml");
  expect(
    (jobs["drive-pr-suite"]?.steps ?? []).some((s) =>
      (s.run ?? "").includes("terminal-states-consistency.ts"),
    ),
  ).toBe(true);
  // The required status check `gates` must wait for the separate job too.
  expect(jobs.gates?.needs).toEqual(["areas", "gate-set", "drive-pr-suite"]);
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
  expect(jobs["gate-set"]?.needs).toBe("areas");
});

test("the changelog must carry the current plugin version, and every change note must read", async () => {
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
  writeFileSync(join(dir, "CHANGELOG.md"), "## [1.2.0] - 2026-01-02\n");
  // Jig's values are the `changelog:` section of its own configuration.
  mkdirSync(join(dir, ".config"));
  writeFileSync(
    join(dir, ".config", "jig.yaml"),
    [
      "changelog:",
      "  file: CHANGELOG.md",
      "  format: keep-a-changelog",
      "  version:",
      "    files:",
      "      - { path: plugin/.claude-plugin/plugin.json, key: version }",
      "      - { path: plugin/.codex-plugin/plugin.json, key: version }",
      "",
    ].join("\n"),
  );
  // The branch rules need a base to compare with; one git cannot find fails.
  expect(checkChangelog(dir)).toBe(1);
  const git = (...args: string[]) =>
    expectSpawnExit(
      safeSpawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: dir,
      }),
      0,
    );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = { JIG_CHANGE_NOTES_BASE: "main" };
  expect(checkChangelog(dir, base)).toBe(0);
  writeFileSync(join(dir, "CHANGELOG.md"), "## [1.1.0] - 2026-01-01\n");
  expect(checkChangelog(dir, base)).toBe(1);
  writeFileSync(join(dir, "CHANGELOG.md"), "## [1.2.0] - 2026-01-02\n");
  mkdirSync(join(dir, "changes"));
  writeFileSync(join(dir, "changes", "a.md"), "### Improved\n\n- x\n");
  expect(checkChangelog(dir, base)).toBe(1);
  writeFileSync(join(dir, "changes", "a.md"), "### Changed\n\n- x\n");
  expect(checkChangelog(dir, base)).toBe(0);
  manifest("codex", "1.3.0");
  expect(checkChangelog(dir, base)).toBe(1);
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
  expect(checkWorkflowSafety(dir, {})).toBe(2);
  writeFileSync(
    join(workflows, "review.yml"),
    readFileSync(join(fixtures, "unsafe/folded-ref-run.yml")),
  );
  expect(checkWorkflowSafety(dir)).toBe(1);
  expect(checkWorkflowSafety(join(dir, "missing"), {})).toBe(2);
  // A repeated key is refused rather than read as its last copy.
  writeFileSync(
    join(workflows, "review.yml"),
    "on: push\njobs:\n  a:\n    runs-on: x\n  a:\n    runs-on: y\n",
  );
  expect(checkWorkflowSafety(dir, {})).toBe(2);
});

test("Jig's workflows pass the workflow-convention lint, and a broken one fails it", () => {
  expect(checkWorkflowConventions(root)).toBe(0);
  const dir = temp();
  const workflows = join(dir, ".github/workflows");
  mkdirSync(workflows, { recursive: true });
  expect(checkWorkflowConventions(dir, {})).toBe(2);
  writeFileSync(
    join(workflows, "ci.yml"),
    "on: push\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: make\n",
  );
  expect(checkWorkflowConventions(dir, {})).toBe(1);
  writeFileSync(join(workflows, "ci.yml"), "on: push\njobs: [unclosed\n");
  expect(checkWorkflowConventions(dir, {})).toBe(2);
  // Jig always has workflows: an action alone has checked none of them.
  const actionOnly = temp();
  mkdirSync(join(actionOnly, ".github/actions/setup"), { recursive: true });
  writeFileSync(
    join(actionOnly, ".github/actions/setup/action.yml"),
    "runs:\n  using: composite\n  steps: []\n",
  );
  expect(checkWorkflowConventions(actionOnly, {})).toBe(2);
});

test("Jig's scheduled workflows are declared, and an undeclared one fails the check", () => {
  expect(checkSchedulesDeclared(root)).toBe(0);
  const dir = temp();
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, ".config"), { recursive: true });
  writeFileSync(
    join(dir, ".github/workflows/cleanup.yml"),
    'on:\n  schedule:\n    - cron: "0 5 * * 1"\njobs: {}\n',
  );
  // No registry: the check could not read what declares the cadence.
  expect(checkSchedulesDeclared(dir)).toBe(2);
  writeFileSync(
    join(dir, ".config/scheduled-jobs.yaml"),
    "jobs:\n  - id: other\n    cadence: 24h\n",
  );
  expect(checkSchedulesDeclared(dir)).toBe(1);
  writeFileSync(
    join(dir, ".config/scheduled-jobs.yaml"),
    "jobs:\n  - id: cleanup\n    cadence: 7d\n",
  );
  expect(checkSchedulesDeclared(dir)).toBe(0);
});

test("the origin-reference gate with no text file to read could not check", () => {
  const dir = temp();
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  mkdirSync(join(dir, "fixtures"));
  writeFileSync(join(dir, "fixtures/a.md"), "skipped\n");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x41, 0, 0x42]));
  const result = run("check-no-tracker-refs", [dir, trackerPatterns]);
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain("could not check: no text file");
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
  // A template in a skill is held to NOTICE like one in a module, nested too.
  put("plugin/skills/k/templates/sub/p.md");
  const skillResult = run(gate, [dir]);
  expectSpawnExit(skillResult, 1);
  expect(skillResult.stderr.toString()).toContain(
    "template plugin/skills/k/templates/sub/p.md is not listed",
  );
  write(
    ["modules/M0-a/templates/a.md", "plugin/skills/k/templates/sub/p.md"],
    ["plugin/x/vendor/lib.LICENSE"],
  );
  expectSpawnExit(run(gate, [dir]), 0);
  rmSync(join(dir, "plugin/skills"), { recursive: true });
  write(["modules/M0-a/templates/a.md"], ["plugin/x/vendor/lib.LICENSE"]);
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
