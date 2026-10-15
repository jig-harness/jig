import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gate = join(import.meta.dir, "check-workflow-conventions.ts");
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);

function run(args: string[], env: Record<string, string> = {}) {
  const { GITHUB_ACTIONS: _, ...inherited } = process.env;
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    env: { ...inherited, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}
const lint = (name: string) => run(["--root", fixture(name)]);

/** The temporary roots a test made, removed after it. */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-conventions-"));
  roots.push(root);
  return root;
};

/** Each fixture is a small repository: its exit code and the rules it
 * must report (none for a pass). */
const cases: [string, number, string[]][] = [
  ["job-timeout-pass", 0, []],
  ["job-timeout-fail", 1, ["job-timeout"]],
  ["pr-concurrency-pass", 0, []],
  ["pr-concurrency-fail", 1, ["pr-concurrency"]],
  ["aggregator-pass", 0, []],
  ["aggregator-always", 1, ["aggregator-unless-cancelled"]],
  ["aggregator-path-filtered", 1, ["required-not-path-filtered"]],
  ["aggregator-not-required", 0, []],
  ["required-checks-fail", 1, ["aggregator-unless-cancelled"]],
  ["ci-hold-pass", 0, []],
  ["ci-hold-fail", 1, ["ci-hold-guard", "ci-hold-sentinel"]],
  ["heavy-pass", 0, []],
  ["heavy-fail", 1, ["heavy-per-change"]],
  ["heavy-marker", 0, []],
  ["heavy-lost", 1, ["heavy-per-change"]],
  ["cache-pass", 0, []],
  ["cache-fail", 1, ["cache-env-parity"]],
  ["pinned-pass", 0, []],
  ["pinned-fail", 1, ["pinned-uses"]],
  ["composite-pass", 0, []],
  ["composite-fail", 1, ["pinned-uses"]],
  ["push-pr-paths-pass", 0, []],
  ["push-pr-paths-fail", 1, ["push-pr-paths"]],
  ["catalog-pass", 0, []],
  ["catalog-fail", 1, ["catalog-paths"]],
  ["reasoned-exception", 0, []],
  ["file-wide-exception", 0, []],
  ["duplicate-exception", 1, ["exception-list"]],
  ["heavy-called", 1, ["heavy-per-change"]],
  ["aggregator-no-if", 1, ["aggregator-unless-cancelled"]],
  ["push-pr-paths-one-sided", 1, ["push-pr-paths"]],
  ["malformed-steps", 2, []],
  ["reasonless-exception", 1, ["exception-list", "job-timeout"]],
  ["stale-exception", 1, ["exception-list"]],
  ["unknown-rule-exception", 2, []],
  ["unparseable", 2, []],
  ["duplicate-key", 2, []],
  ["not-a-workflow", 2, []],
  ["malformed-config", 2, []],
  ["malformed-jig-config", 2, []],
  ["empty", 2, []],
];
for (const [name, code, rules] of cases)
  test(name, () => {
    const { code: actual, err } = lint(name);
    expect(actual).toBe(code);
    const reported = [...err.matchAll(/: \[([a-z-]+)\] /g)].map((m) => m[1]);
    expect([...new Set(reported)].sort()).toEqual([...rules].sort());
    if (code === 2) expect(err).toContain("could not check");
  });

test("a finding names its file, line, rule, problem and fix", () => {
  const lines = lint("job-timeout-fail").err.split("\n");
  expect(lines[0]).toBe(
    ".github/workflows/ci.yml:3: [job-timeout] job 'untimed' has no timeout-minutes",
  );
  expect(lines[1]).toStartWith("  fix: set timeout-minutes");
  expect(lines[2]).toContain(
    "[job-timeout] job 'at-default' has timeout-minutes 360, not a positive number of minutes within the 60-minute ceiling",
  );
  expect(lines.join("\n")).toContain(
    "[job-timeout] job 'over-ceiling' has timeout-minutes 61",
  );
});

test("a reusable-workflow call needs no timeout of its own", () =>
  expect(lint("job-timeout-pass").err).not.toContain("reusable"));

test("an exception needs a reason, and one that suppresses nothing is stale", () => {
  expect(lint("reasonless-exception").err).toContain(
    ".config/workflow-conventions-exceptions.txt:1: [exception-list] exception 'job-timeout .github/workflows/ci.yml untimed' has no reason",
  );
  expect(lint("stale-exception").err).toContain(
    ".config/workflow-conventions-exceptions.txt:2: [exception-list] exception 'job-timeout .github/workflows/ci.yml build' suppresses no finding",
  );
});

test("a pass says which rules had nothing configured to check", () => {
  const { out } = lint("pinned-pass");
  expect(out).toContain("CI hold: not configured");
  expect(out).toContain("cache-env-parity not applicable");
  expect(out).toContain("catalog-paths not applicable");
  expect(out).toContain("OK — 1 workflow(s), 0 composite action(s)");
  expect(lint("aggregator-pass").out).toContain(
    "required checks: ci.yml#verdict (derived: aggregator jobs)",
  );
  expect(lint("ci-hold-pass").out).toContain(
    "required checks: ci.yml#verdict (from ci.required_checks)",
  );
});

test("the unpinned references are each reported on their own line", () => {
  const { err } = lint("pinned-fail");
  expect(err).toContain(
    ".github/workflows/ci.yml:7: [pinned-uses] 'actions/checkout@v4'",
  );
  expect(err).toContain(
    ".github/workflows/ci.yml:8: [pinned-uses] 'docker://alpine:3.20'",
  );
  expect(err).toContain(
    ".github/workflows/ci.yml:10: [pinned-uses] 'example/workflows/.github/workflows/build.yml@main'",
  );
  expect(lint("composite-fail").err).toContain(
    ".github/actions/setup/action.yml:6: [pinned-uses] 'actions/cache@v4'",
  );
});

test("a catalog area listed in part names its missing globs", () =>
  expect(lint("catalog-fail").err).toContain(
    "paths docs/**, lib/** are not the whole glob list of any change-area catalog area; partly listed: docs (*.md missing)",
  ));

test("a repeated key is refused, not read as its last copy", () =>
  expect(lint("duplicate-key").err).toContain("duplicated mapping key"));

test("a file named on the command line must exist", () => {
  const root = fixture("pinned-pass");
  for (const option of ["--config", "--jig-config", "--exceptions"])
    expect(run(["--root", root, option, join(root, "missing")]).code).toBe(2);
  expect(run(["--root", root, "--unknown"]).code).toBe(2);
});

test("an unreadable workflows folder could not be checked", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const root = tempRoot();
  const dir = join(root, ".github/workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ci.yml"),
    "on: push\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n    steps: [{ run: make }]\n",
  );
  chmodSync(dir, 0);
  try {
    expect(run(["--root", root]).code).toBe(2);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test("under GitHub Actions a finding is also an annotation", () =>
  expect(
    run(["--root", fixture("job-timeout-fail")], { GITHUB_ACTIONS: "true" })
      .out,
  ).toContain(
    "::error file=.github/workflows/ci.yml,line=3,title=job-timeout::",
  ));

/** A throwaway repository holding `files`, for cases that vary one line. */
function repo(files: Record<string, string>): string {
  const root = tempRoot();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CONC = `concurrency:\n  group: ci-\${{ github.ref }}\n  cancel-in-progress: true\n`;
const LABELS = "github.event.pull_request.labels.*.name";

/** A pull-request workflow whose required `verdict` job needs a heavy `e2e`
 * job; `e2eIf` is e2e's condition and `stepIf` the condition of verdict's
 * failing step. */
function holdRepo(label: string, e2eIf: string, stepIf: string) {
  return repo({
    ".config/jig.yaml": `ci:\n  required_checks: [verdict]\n  hold_label: "${label}"\n`,
    ".config/workflow-conventions.yaml": "heavy:\n  - ci.yml#e2e\n",
    ".config/workflow-conventions-exceptions.txt":
      "# The merge waits for it.\nheavy-per-change .github/workflows/ci.yml e2e\n",
    ".github/workflows/ci.yml": `on: pull_request\n${CONC}jobs:\n  e2e:\n    if: "${e2eIf}"\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: make e2e\n  verdict:\n    needs: [e2e]\n    if: \${{ !cancelled() }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - if: "${stepIf}"\n        run: exit 1\n`,
  });
}
const rulesOf = (err: string) =>
  [...new Set([...err.matchAll(/: \[([a-z-]+)\] /g)].map((m) => m[1]))].sort();

test("a sentinel is only a plain positive test for the exact label", () => {
  const guard = `!contains(${LABELS}, 'ci:hold')`;
  expect(
    run([
      "--root",
      holdRepo("ci:hold", guard, `contains(${LABELS}, 'ci:hold')`),
    ]).code,
  ).toBe(0);
  expect(
    run([
      "--root",
      holdRepo("ci:hold", guard, `\${{ contains(${LABELS}, 'ci:hold') }}`),
    ]).code,
  ).toBe(0);
  for (const spelling of [
    `!(contains(${LABELS}, 'ci:hold'))`,
    "!contains(toJSON(github.event.pull_request.labels), 'ci:hold')",
    `contains(${LABELS}, 'ci:hold') == false`,
    `contains(${LABELS}, 'ci:hold') || github.run_attempt > 1`,
    `contains(${LABELS}, 'ci:hold-off')`,
    "contains('unrelated', 'ci:hold')",
  ]) {
    const { code, err } = run(["--root", holdRepo("ci:hold", guard, spelling)]);
    expect({ spelling, code, rules: rulesOf(err) }).toEqual({
      spelling,
      code: 1,
      rules: ["ci-hold-sentinel"],
    });
  }
});

test("the hold guard names the exact label inside a negated contains", () => {
  const sentinelIf = `contains(${LABELS}, 'hold')`;
  for (const guard of [
    `!contains(${LABELS}, 'hold')`,
    `!(contains(${LABELS}, 'hold'))`,
    `github.event.action != 'closed' && !contains(${LABELS}, 'hold')`,
  ])
    expect({
      guard,
      code: run(["--root", holdRepo("hold", guard, sentinelIf)]).code,
    }).toEqual({
      guard,
      code: 0,
    });
  for (const guard of [
    `!contains(${LABELS}, 'on-hold')`,
    `contains(${LABELS}, 'hold')`,
    `!contains(${LABELS}, 'hold') || true`,
    `github.event.action == 'unlabeled' || !contains(${LABELS}, 'hold')`,
    "github.event.label.name != 'hold'",
    `!!contains(${LABELS}, 'hold')`,
    `!contains(${LABELS}, 'hold') == false`,
    "!contains('unrelated', 'hold')",
    `!(!contains(${LABELS}, 'hold'))`,
    `github.event.action != '!contains(${LABELS}, ''hold'')'`,
  ]) {
    const { code, err } = run(["--root", holdRepo("hold", guard, sentinelIf)]);
    expect({ guard, code, rules: rulesOf(err) }).toEqual({
      guard,
      code: 1,
      rules: ["ci-hold-guard"],
    });
  }
});

test("one exception covers every finding of its rule in its file", () => {
  expect(lint("file-wide-exception").out).toContain("1 exception(s)");
  expect(lint("duplicate-exception").err).toContain(
    "exceptions.txt:3: [exception-list] exception 'job-timeout .github/workflows/ci.yml' suppresses no finding",
  );
});

test("a heavy workflow called by a pull-request workflow runs per change", () =>
  expect(lint("heavy-called").err).toContain(
    "heavy suite e2e.yml runs on every change (pull_request via ci.yml)",
  ));

test("a job needing every other job is the aggregator even with no if:", () =>
  expect(lint("aggregator-no-if").err).toContain(
    "required job 'verdict' needs other jobs but does not run on !cancelled()",
  ));

test("a path filter on only one of push and pull request is reported", () =>
  expect(lint("push-pr-paths-one-sided").err).toContain(
    "only the push trigger is filtered by paths",
  ));

test("malformed steps, needs or env could not be checked", () => {
  const workflow = (job: string) =>
    repo({
      ".github/workflows/ci.yml": `on: push\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n    steps: [{ run: make }]\n  b:\n    runs-on: x\n    timeout-minutes: 5\n${job}`,
    });
  for (const job of [
    "    steps: { run: make }\n",
    "    steps: [make]\n",
    "    needs: { a: true }\n    steps: []\n",
    "    env: [A=1]\n    steps: []\n",
  ]) {
    const { code, err } = run(["--root", workflow(job)]);
    expect({ job, code }).toEqual({ job, code: 2 });
    expect(err).toContain("job b");
  }
  expect(lint("malformed-steps").err).toContain("steps: not a list of steps");
});

test("a finding's line is the job's own key, not a same-named key elsewhere", () => {
  const root = repo({
    ".github/workflows/ci.yml": `on:\n  push:\n    branches: [main]\njobs:\n  lint:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          build: yes\n  build:\n    runs-on: x\n    steps:\n      - run: make\n`,
  });
  expect(run(["--root", root]).err).toContain(
    ".github/workflows/ci.yml:12: [job-timeout] job 'build'",
  );
});

test("an action installed under node_modules is not the repository's own", () => {
  const root = repo({
    ".github/actions/node_modules/dep/action.yml":
      "runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v4\n",
    ".github/actions/setup/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: actions/cache@${SHA}\n`,
  });
  expect(run(["--root", root]).code).toBe(0);
});

const HOLD = 'ci:\n  hold_label: "hold"\n';
const job = (id: string, extra = "") =>
  `  ${id}:\n    runs-on: x\n    timeout-minutes: 5\n${extra}    steps:\n      - run: make ${id}\n`;
const SENTINEL_STEP = `      - if: contains(${LABELS}, 'hold')\n        run: exit 1\n`;

test("a heavy job that needs every other job is not the aggregator", () => {
  const { code, err } = run([
    "--root",
    repo({
      ".config/jig.yaml": HOLD,
      ".config/workflow-conventions.yaml": "heavy:\n  - e2e.yml#e2e\n",
      ".config/workflow-conventions-exceptions.txt":
        "# The merge waits for it.\nheavy-per-change .github/workflows/e2e.yml e2e\n",
      ".github/workflows/e2e.yml": `on: pull_request\n${CONC}jobs:\n${job("build")}${job("e2e", `    needs: [build]\n    if: \${{ !cancelled() }}\n`)}`,
    }),
  ]);
  expect(code).toBe(1);
  expect(err).toContain("[ci-hold-guard] heavy job 'e2e'");
  expect(err).not.toContain("aggregator-unless-cancelled");
});

test("a pull-request job calling a heavy workflow carries the hold guard", () => {
  const files = (callerIf: string) => ({
    ".config/jig.yaml": HOLD,
    ".config/workflow-conventions.yaml": "heavy:\n  - e2e.yml\n",
    ".config/workflow-conventions-exceptions.txt":
      "# The merge waits for it.\nheavy-per-change .github/workflows/e2e.yml\n",
    ".github/workflows/e2e.yml": `on: workflow_call\njobs:\n${job("e2e")}`,
    ".github/workflows/ci.yml": `on: pull_request\n${CONC}jobs:\n  e2e:\n${callerIf}    uses: ./.github/workflows/e2e.yml\n  verdict:\n    needs: [e2e]\n    if: \${{ !cancelled() }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n${SENTINEL_STEP}`,
  });
  const unguarded = run(["--root", repo(files(""))]);
  expect(unguarded.code).toBe(1);
  expect(rulesOf(unguarded.err)).toEqual(["ci-hold-guard"]);
  expect(unguarded.err).toContain(
    ".github/workflows/ci.yml:6: [ci-hold-guard] heavy job 'e2e'",
  );
  expect(
    run([
      "--root",
      repo(files(`    if: \${{ !contains(${LABELS}, 'hold') }}\n`)),
    ]).code,
  ).toBe(0);
});

test("a sentinel counts only where it fails a required check", () => {
  const { err } = run([
    "--root",
    repo({
      ".config/jig.yaml": HOLD,
      ".github/workflows/ci.yml": `on: pull_request\n${CONC}jobs:\n  lone:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n${SENTINEL_STEP}`,
    }),
  ]);
  expect(rulesOf(err)).toEqual(["ci-hold-sentinel"]);
});

test("a release workflow's last job is not taken as an aggregator", () =>
  expect(
    run([
      "--root",
      repo({
        ".github/workflows/release.yml": `on:\n  push:\n    tags: [v*]\njobs:\n${job("build")}${job("publish", "    needs: [build]\n")}`,
      }),
    ]).code,
  ).toBe(0));

test("a push filtered only by tags is not compared with pull-request paths", () => {
  for (const tags of ["tags: [v*]", "tags-ignore: [nightly-*]"])
    expect({
      tags,
      code: run([
        "--root",
        repo({
          ".github/workflows/docs.yml": `on:\n  pull_request:\n    paths: [docs/**]\n  push:\n    ${tags}\n${CONC}jobs:\n${job("docs")}`,
        }),
      ]).code,
    }).toEqual({ tags, code: 0 });
});

test("a heavy suite pushed only for tags does not run per change", () => {
  for (const tags of ["tags: [v*]", "tags-ignore: [nightly-*]"])
    expect({
      tags,
      code: run([
        "--root",
        repo({
          ".config/workflow-conventions.yaml": "heavy:\n  - release.yml\n",
          ".github/workflows/release.yml": `on:\n  push:\n    ${tags}\njobs:\n${job("e2e")}`,
        }),
      ]).code,
    }).toEqual({ tags, code: 0 });
});

test("in a whole heavy workflow a derived aggregator still needs the guard", () => {
  const files = (requiredChecks: string) => ({
    ".config/jig.yaml": `ci:\n${requiredChecks}  hold_label: "hold"\n`,
    ".config/workflow-conventions.yaml": "heavy:\n  - e2e.yml\n",
    ".config/workflow-conventions-exceptions.txt":
      "# The merge waits for it.\nheavy-per-change .github/workflows/e2e.yml\n",
    ".github/workflows/e2e.yml": `on: pull_request\n${CONC}jobs:\n${job("build", `    if: \${{ !contains(${LABELS}, 'hold') }}\n`)}  e2e:\n    needs: [build]\n    if: \${{ !cancelled() }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n${SENTINEL_STEP}      - run: make e2e\n`,
  });
  const derived = run(["--root", repo(files(""))]);
  expect(derived.code).toBe(1);
  expect(derived.err).toContain("[ci-hold-guard] heavy job 'e2e'");
  expect(run(["--root", repo(files("  required_checks: [e2e]\n"))]).code).toBe(
    0,
  );
});

test("a Docker action's image is pinned to a digest", () => {
  const action = (image: string) =>
    repo({
      ".github/actions/tool/action.yml": `runs:\n  using: docker\n  image: ${image}\n`,
    });
  expect(run(["--root", action("Dockerfile")]).code).toBe(0);
  expect(
    run(["--root", action(`docker://alpine@sha256:${"a".repeat(64)}`)]).code,
  ).toBe(0);
  expect(run(["--root", action("docker://alpine:3.20")]).err).toContain(
    ".github/actions/tool/action.yml:3: [pinned-uses] 'docker://alpine:3.20'",
  );
});

test("an aggregator runs on exactly !cancelled(), nothing joined to it", () => {
  const files = (cond: string) =>
    repo({
      ".github/workflows/ci.yml": `on: pull_request\n${CONC}jobs:\n${job("build")}  verdict:\n    needs: [build]\n    if: "${cond}"\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: make verdict\n`,
    });
  expect(run(["--root", files(`\${{ !cancelled() }}`)]).code).toBe(0);
  for (const cond of [
    `\${{ !cancelled() && success() }}`,
    `\${{ !cancelled() == false }}`,
    `\${{ cancelled() || !cancelled() }}`,
  ]) {
    const { code, err } = run(["--root", files(cond)]);
    expect({ cond, code, rules: rulesOf(err) }).toEqual({
      cond,
      code: 1,
      rules: ["aggregator-unless-cancelled"],
    });
  }
});

/** A pull-request workflow whose required `verdict` needs a guarded heavy
 * `e2e`; `e2eSteps` and `verdictSteps` are their extra steps, `between` jobs
 * placed in the chain e2e -> … -> verdict. */
function sentinelRepo(e2eSteps: string, verdictSteps: string, between = "") {
  return repo({
    ".config/jig.yaml": `ci:\n  required_checks: [verdict]\n  hold_label: "hold"\n`,
    ".config/workflow-conventions.yaml": "heavy:\n  - ci.yml#e2e\n",
    ".config/workflow-conventions-exceptions.txt":
      "# The merge waits for it.\nheavy-per-change .github/workflows/ci.yml e2e\n",
    ".github/workflows/ci.yml": `on: pull_request\n${CONC}jobs:\n  e2e:\n    if: \${{ !contains(${LABELS}, 'hold') }}\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n${e2eSteps}      - run: make e2e\n${between}  verdict:\n    needs: [${between ? "build" : "e2e"}]\n    if: \${{ !cancelled() }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n${verdictSteps}      - run: make verdict\n`,
  });
}

test("a sentinel the hold skips, or whose failure is tolerated, is none", () => {
  for (const [what, root] of [
    ["in a job skipped while held", sentinelRepo(SENTINEL_STEP, "")],
    [
      "continuing on error",
      sentinelRepo("", `${SENTINEL_STEP}        continue-on-error: true\n`),
    ],
  ] as const) {
    const { code, err } = run(["--root", root]);
    expect({ what, code, rules: rulesOf(err) }).toEqual({
      what,
      code: 1,
      rules: ["ci-hold-sentinel"],
    });
  }
  expect(run(["--root", sentinelRepo("", SENTINEL_STEP)]).code).toBe(0);
});

test("a sentinel counts only where its failure is proven to reach the required check", () => {
  const sentinelJob = (cond = "") =>
    `  sentinel:\n${cond}    runs-on: x\n    timeout-minutes: 5\n    steps:\n${SENTINEL_STEP}`;
  // Its own job, needed directly by the required check on !cancelled().
  const direct = (cond = "", verdictIf = `    if: \${{ !cancelled() }}\n`) =>
    repo({
      ".config/jig.yaml": `ci:\n  required_checks: [verdict]\n  hold_label: "hold"\n`,
      ".github/workflows/ci.yml": `on: pull_request\n${CONC}jobs:\n${sentinelJob(cond)}  verdict:\n    needs: [sentinel]\n${verdictIf}    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: make verdict\n`,
    });
  expect(run(["--root", direct()]).code).toBe(0);
  expect(run(["--root", direct(`    if: \${{ !cancelled() }}\n`)]).code).toBe(
    0,
  );
  // Through an intermediary that can succeed whatever the sentinel returned.
  const chain = `${sentinelJob()}  build:\n    needs: [sentinel, e2e]\n    if: \${{ !cancelled() }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: make build\n`;
  const sentinel = ["ci-hold-sentinel"];
  for (const [what, root, rules] of [
    ["through another job", sentinelRepo("", "", chain), sentinel],
    ["in a job that never runs", direct("    if: false\n"), sentinel],
    ["in a job on an expression", direct(`    if: \${{ false }}\n`), sentinel],
    [
      "needed by a check a failed need skips",
      direct("", ""),
      ["aggregator-unless-cancelled", ...sentinel],
    ],
  ] as const) {
    const { code, err } = run(["--root", root]);
    expect({ what, code, rules: rulesOf(err) }).toEqual({
      what,
      code: 1,
      rules: [...rules],
    });
  }
});

test("push paths are compared, in order when negated, with each pull-request trigger", () => {
  const files = (push: string, pr: string, prTarget?: string) =>
    repo({
      ".github/workflows/docs.yml": `on:\n  push:\n    paths: ${push}\n  pull_request:\n    paths: ${pr}\n${prTarget ? `  pull_request_target:\n    paths: ${prTarget}\n` : ""}${CONC}jobs:\n${job("docs")}`,
    });
  expect(run(["--root", files("[a/**, b/**]", "[b/**, a/**]")]).code).toBe(0);
  const negated = run([
    "--root",
    files(
      "[docs/**, '!docs/private/**', docs/private/keep.md]",
      "[docs/**, docs/private/keep.md, '!docs/private/**']",
    ),
  ]);
  expect(rulesOf(negated.err)).toEqual(["push-pr-paths"]);
  const target = run(["--root", files("[docs/**]", "[docs/**]", "[lib/**]")]);
  expect(target.err).toContain("differ from the pull_request_target trigger's");
});

test("a malformed trigger, action or required-check list could not be checked", () => {
  const timed = `jobs:\n${job("a")}`;
  for (const [what, files] of [
    [
      "event settings as a list",
      { ".github/workflows/ci.yml": `on:\n  pull_request: [paths]\n${timed}` },
    ],
    [
      "an event that is not a name",
      { ".github/workflows/ci.yml": `on: [{ push: 1 }]\n${timed}` },
    ],
    [
      "a path filter that is not a list",
      {
        ".github/workflows/ci.yml": `on:\n  push:\n    paths: docs/**\n${timed}`,
      },
    ],
    ["no job", { ".github/workflows/ci.yml": "on: push\njobs: {}\n" }],
    [
      "an action with no runs",
      { ".github/actions/a/action.yml": "name: broken\n" },
    ],
    [
      "an action whose runs is not a map",
      { ".github/actions/a/action.yml": "runs: false\n" },
    ],
    [
      "a composite action with no steps",
      { ".github/actions/a/action.yml": "runs:\n  using: composite\n" },
    ],
    [
      "an action whose runtime GitHub does not know",
      {
        ".github/actions/a/action.yml":
          "runs:\n  using: composit\n  main: index.js\n",
      },
    ],
    [
      "a schedule with no entries",
      { ".github/workflows/ci.yml": `on:\n  schedule:\n${timed}` },
    ],
    [
      "a schedule entry with no cron",
      { ".github/workflows/ci.yml": `on:\n  schedule: [{}]\n${timed}` },
    ],
    [
      "a schedule named as the one event",
      { ".github/workflows/ci.yml": `on: schedule\n${timed}` },
    ],
    [
      "a schedule named in a list of events",
      { ".github/workflows/ci.yml": `on: [push, schedule]\n${timed}` },
    ],
    [
      "a blank required check",
      {
        ".config/jig.yaml": "ci:\n  required_checks: ['']\n",
        ".github/workflows/ci.yml": `on: push\n${timed}`,
      },
    ],
    [
      "a repeated required check",
      {
        ".config/jig.yaml": "ci:\n  required_checks: [a, a]\n",
        ".github/workflows/ci.yml": `on: push\n${timed}`,
      },
    ],
  ] as const) {
    const { code, err } = run(["--root", repo(files)]);
    expect({ what, code }).toEqual({ what, code: 2 });
    expect(err).toContain("could not check");
  }
  expect(
    run([
      "--root",
      repo({
        ".config/jig.yaml": "ci:\n  required_checks: []\n",
        ".github/workflows/ci.yml": `on:\n  schedule:\n    - cron: '0 3 * * *'\n${timed}`,
      }),
    ]).code,
  ).toBe(0);
});

test("a folder named on the command line must exist", () => {
  const root = repo({
    ".github/actions/a/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: actions/cache@${SHA}\n`,
    ".github/workflows/ci.yml": `on: push\njobs:\n${job("a")}`,
  });
  expect(run(["--root", root]).code).toBe(0);
  for (const option of ["--workflows", "--actions"])
    expect(run(["--root", root, option, join(root, "missing")]).code).toBe(2);
});
