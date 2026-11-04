// The mirror step of .github/workflows/gates.yml: on a label event other than
// the CI hold's, `gates` repeats the newest real run's result. The test runs the
// step's own script, read from the workflow, under bash with a fake `gh` that
// answers from canned API responses through the step's own `--jq` filters (so
// `jq` must be installed) and a `timeout` that only runs its command.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { load } from "../lib/vendor/js-yaml.mjs";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../lib/test-helpers/fake-program.ts";

const STEP = "Repeat the newest real run's result";
const workflow = load(
  readFileSync(join(import.meta.dir, "../.github/workflows/gates.yml"), "utf8"),
) as {
  jobs: Record<
    string,
    { steps: { name?: string; run?: string; env?: Record<string, string> }[] }
  >;
};
const step = workflow.jobs.gates?.steps.find((s) => s.name === STEP);

const scratch = mkdtempSync(join(tmpdir(), "gates-mirror-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let cases = 0;

/** A run in the listing `actions/workflows/gates.yml/runs` answers. */
const run = (id: number, status: string, title = "Fix the widget") => ({
  id,
  status,
  display_title: title,
});
const SELF = 900;
const self = run(SELF, "in_progress", "gates mirror (docs label)");
const listing = (...runs: object[]) => ({ workflow_runs: runs });
const jobs = (gates: string | null) => ({
  jobs: [
    { name: "change areas", conclusion: "success" },
    ...(gates === null ? [] : [{ name: "gates", conclusion: gates }]),
  ],
});
/** A read the fake `gh` refuses, as a failed API call would. */
const FAIL = "FAIL";

/**
 * Runs the step against `runs` (the listing's answers, one per read, the last
 * repeating) and `jobs` (likewise); returns the result and the endpoints read.
 */
function mirror(
  runs: (object | string)[],
  jobsAnswers: (object | string)[],
  env: Record<string, string> = {},
) {
  if (!step?.run || !step.env)
    throw new Error(`gates.yml has no step '${STEP}'`);
  const dir = join(scratch, String(cases++));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const answers = { runs, jobs: jobsAnswers };
  writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
  writeFakeProgram(
    join(bin, "gh"),
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [, endpoint, flag, filter] = process.argv.slice(2);
const dir = ${JSON.stringify(dir)};
const kind = /\\/jobs\\?/.test(endpoint) ? "jobs" : "runs";
appendFileSync(dir + "/calls.log", endpoint + "\\n");
const count = dir + "/" + kind + ".count";
const n = existsSync(count) ? Number(readFileSync(count, "utf8")) : 0;
writeFileSync(count, String(n + 1));
const list = JSON.parse(readFileSync(dir + "/answers.json", "utf8"))[kind];
const answer = list[Math.min(n, list.length - 1)];
if (answer === ${JSON.stringify(FAIL)} || flag !== "--jq") {
  console.error("gh: HTTP 502");
  process.exit(1);
}
const jq = Bun.spawnSync(["jq", "-r", filter], { stdin: new TextEncoder().encode(JSON.stringify(answer)), env: process.env });
process.stdout.write(jq.stdout);
process.stderr.write(jq.stderr);
process.exit(jq.exitCode ?? 1);
`,
  );
  writeFakeProgram(
    join(bin, "timeout"),
    `#!/usr/bin/env bash\nshift\nexec "$@"\n`,
  );
  const script = join(dir, "step.sh");
  writeFileSync(script, step.run);
  const result = Bun.spawnSync(["bash", "-e", script], {
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      MIRROR: step.env.MIRROR ?? "",
      DEADLINE_SECONDS: step.env.DEADLINE_SECONDS ?? "",
      GRACE_SECONDS: step.env.GRACE_SECONDS ?? "",
      POLL_SECONDS: "0",
      GH_TOKEN: "token",
      HEAD_SHA: "a".repeat(40),
      SELF: String(SELF),
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_SERVER_URL: "https://github.example",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = join(dir, "calls.log");
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    // No call reached the fake: calls stays empty.
  }
  return {
    result,
    out: result.stdout.toString(),
    calls,
  };
}

test("jq is installed, as the fake gh needs it to apply the step's filters", () =>
  expect(Bun.which("jq")).not.toBeNull());

test("the step's marker is the start of the name run-name gives a mirror run", () => {
  const raw = readFileSync(
    join(import.meta.dir, "../.github/workflows/gates.yml"),
    "utf8",
  );
  const name = raw.match(/^run-name: .*format\('([^']*)\{0\}/m)?.[1];
  expect(step?.env?.MIRROR).toBeTruthy();
  expect(name).toBe(step?.env?.MIRROR);
});

test("it passes only when the newest real run's gates passed", () => {
  const passed = mirror(
    [listing(run(100, "completed"), self)],
    [jobs("success")],
  );
  expectSpawnExit(passed.result, 0, "a passing real gates");
  expect(passed.out).toContain("::notice::");
  expect(passed.out).toContain(
    "https://github.example/owner/repo/actions/runs/100",
  );
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
    const failed = mirror(
      [listing(run(100, "completed"), self)],
      [jobs(conclusion)],
    );
    expectSpawnExit(failed.result, 1, conclusion);
    expect(failed.out).toContain(`its gates job: ${conclusion}`);
  }
  const missing = mirror([listing(run(100, "completed"), self)], [jobs(null)]);
  expectSpawnExit(missing.result, 1, "a real run without its gates job");
  expect(missing.out).toContain("its gates job: missing");
});

test("it repeats the newest real run, never a mirror run or itself", () => {
  const { result, calls } = mirror(
    [
      listing(
        self,
        run(300, "completed", "gates mirror (xs label)"),
        run(100, "completed"),
        run(50, "completed"),
      ),
    ],
    [jobs("failure")],
  );
  expectSpawnExit(
    result,
    1,
    "the newest real run failed, older and mirror runs passed",
  );
  expect(calls.at(-1)).toContain("/actions/runs/100/jobs");
});

test("it waits for a real run in flight", () => {
  const { result, calls } = mirror(
    [
      listing(run(100, "queued"), self),
      listing(run(100, "in_progress"), self),
      listing(run(100, "completed"), self),
    ],
    [jobs("success")],
  );
  expectSpawnExit(result, 0, "the run completed on the third read");
  expect(
    calls.filter((c) => c.includes("/workflows/gates.yml/runs")).length,
  ).toBe(3);
});

test("it fails when no real run appears within the grace period", () => {
  const { result, out } = mirror([listing(self)], [jobs("success")], {
    GRACE_SECONDS: "1",
    POLL_SECONDS: "1",
  });
  expectSpawnExit(result, 1, "only mirror runs on the head");
  expect(out).toContain("no real gates run exists");
});

test("three failed reads in a row fail it; fewer do not", () => {
  const failing = mirror(
    [FAIL, FAIL, FAIL, listing(run(100, "completed"))],
    [jobs("success")],
  );
  expectSpawnExit(failing.result, 1, "three failed reads");
  expect(failing.out).toContain("three API reads in a row failed");
  // A read that answers starts the count again: two failures, an answer, a
  // failure, then answers.
  const recovering = mirror(
    [FAIL, FAIL, listing(run(100, "completed"))],
    [FAIL, jobs("success")],
  );
  expectSpawnExit(recovering.result, 0, "two failed reads, then answers");
});

test("it fails at its deadline while the real run is still running", () => {
  const { result, out } = mirror(
    [listing(run(100, "in_progress"), self)],
    [jobs("success")],
    {
      DEADLINE_SECONDS: "1",
      POLL_SECONDS: "1",
    },
  );
  expectSpawnExit(result, 1, "a real run that outlasts the deadline");
  expect(out).toContain("before this run's deadline");
});
