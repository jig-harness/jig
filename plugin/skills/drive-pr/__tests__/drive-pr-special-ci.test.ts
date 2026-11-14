import { writeState } from "./state-rows.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { advisoryKey } from "../scripts/lib/driver/advisory-ci.ts";
import type { CheckRun } from "../scripts/lib/status/evidence.ts";
/** Exercise final-CI dispositions with the real policy reader and durable park writer. */
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  useDrivePrSuite,
  makeScratchRepo,
  gitCleanEnv,
  writeFixture,
  binDir,
  SCRIPTS,
} from "./drive-pr-harness.ts";

useDrivePrSuite();
let sequence = 0;
function setup(config = "") {
  const repo = makeScratchRepo(`special-ci-${++sequence}`);
  mkdirSync(join(repo.dir, ".config"), { recursive: true });
  writeFileSync(
    join(repo.dir, ".config/jig.yaml"),
    `ci:\n  required_checks: [gate]\n  hold_label: ci:hold\n  hold_sentinels: [custom sentinel]\n  advisory_checks: [scan]\ndispatch:\n  person: operator\n${config}`,
  );
  mkdirSync(join(repo.dir, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(repo.dir, ".github/workflows/ci.yaml"),
    `jobs:\n  gate:\n    name: gate\n    if: "!cancelled()"\n    steps:\n      - if: contains(github.event.pull_request.labels.*.name, 'ci:hold')\n        run: exit 1\n`,
  );
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: repo.dir,
      env: gitCleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(
      { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr },
      0,
    );
    return r.stdout.toString().trim();
  };
  git("add", "-A");
  git("commit", "-qm", "CI policy");
  const head = git("rev-parse", "HEAD");
  const fixture = writeFixture(
    { threads: [], head, reviewedSha: head, ciHeld: true },
    repo.dir,
  );
  return { ...repo, ...fixture, head, repoDir: repo.dir };
}
async function child(f: ReturnType<typeof setup>, source: string) {
  const path = join(f.dir, "probe.ts");
  writeFileSync(path, `#!/usr/bin/env bun\n${source}`, { mode: 0o755 });
  const p = Bun.spawn(scriptArgv(path), {
    cwd: f.repoDir,
    env: {
      ...gitCleanEnv(),
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      DRIVE_PR_FIXTURES: f.dir,
      DRIVE_PR_STATE_DIR: f.stateDir,
      DRIVE_PR_HANDOFF_DIR: join(f.dir, "handoff"),
      DRIVE_PR_POLICY_BASE: f.head,
      DRIVE_PR_TARGET: "999",
      JIG_OVERLAY: join(f.repoDir, ".config/jig.yaml"),
      DRIVE_PR_LEDGER: "off",
      JIG_LOG: "debug",
      DRIVE_PR_FINAL_CI_POLL_MS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const r = { stdout, stderr, exitCode };
  expectSpawnExit(r, 0);
  return r;
}
const minuteAt = (minute: number) => `2026-11-13T09:0${minute}:00Z`;
/** One workflow run of `workflow-runs.json`, in check suite `id`. */
function run(
  id: number,
  conclusion: string | null,
  minute: number,
  o: { status?: string; workflowId?: number; attempt?: number } = {},
) {
  const at = minuteAt(minute);
  return {
    id,
    workflow_id: o.workflowId ?? 1,
    status: o.status ?? "completed",
    conclusion,
    check_suite_id: id,
    created_at: at,
    run_started_at: at,
    run_attempt: o.attempt ?? 1,
  };
}
function writeRuns(
  f: ReturnType<typeof setup>,
  runs: ReturnType<typeof run>[],
) {
  writeFileSync(
    join(f.dir, "workflow-runs.json"),
    JSON.stringify({ workflow_runs: runs }),
  );
}
/** One GitHub Actions check run on the head. */
function check(
  name: string,
  id: number,
  conclusion: string | null,
  minute: number,
  status = "completed",
): CheckRun {
  return {
    name,
    id,
    status,
    conclusion,
    app: "github-actions",
    title: "",
    started: minuteAt(minute),
  };
}
/** The CI report for `checks`, each placed in check suite `id` when `suites`. */
async function report(
  f: ReturnType<typeof setup>,
  checks: CheckRun[],
  suites = false,
) {
  const runs = suites ? checks.map((c) => ({ ...c, suiteId: c.id })) : checks;
  const source = `import {ciReportFor} from ${JSON.stringify(evidence)};console.log(JSON.stringify(await ciReportFor("example-org","example-repo",process.env.DRIVE_PR_POLICY_BASE,${JSON.stringify(runs)},false,"999")));`;
  return JSON.parse((await child(f, source)).stdout);
}
async function releaseHold(f: ReturnType<typeof setup>) {
  const path = join(f.dir, "pr-view.json");
  const view = await Bun.file(path).json();
  view.labels = [];
  writeFileSync(path, JSON.stringify(view));
}
const evidence = join(SCRIPTS, "lib/status/evidence.ts");
const convergence = join(SCRIPTS, "lib/driver/convergence-ci.ts");
const heldModule = join(SCRIPTS, "lib/held-checks.ts");
const storeModule = join(SCRIPTS, "lib/driver/rearm.ts");
function evaluate(names: string[], verdict: string) {
  return `const c={pr:"999",ciRepairs:0,ciRepairBudget:2,dryRun:false,agent:[]}; const result=await evaluateFinalCi(${JSON.stringify(verdict)},false,c,{code:0},process.env.DRIVE_PR_POLICY_BASE,null,{checkRunNames:${JSON.stringify(names)},statusNames:[],runs:[]}); console.log(JSON.stringify({result,repairs:c.ciRepairs}));`;
}

test("held M13 and named checks wait without CI repair, release restores failures", async () => {
  const f = setup();
  const r = await child(
    f,
    `import {liveHeldChecks} from ${JSON.stringify(heldModule)}; import {evaluateFinalCi} from ${JSON.stringify(convergence)}; console.log(JSON.stringify(await liveHeldChecks("999"))); ${evaluate([], "held: gate, custom sentinel")}`,
  );
  expect(r.stdout).toContain('"custom sentinel","gate"');
  expect(r.stdout).toContain('"result":"continue","repairs":0');
  await releaseHold(f);
  const released = await child(
    f,
    `import {liveHeldChecks} from ${JSON.stringify(heldModule)}; import {evaluateFinalCi} from ${JSON.stringify(convergence)};console.log(JSON.stringify(await liveHeldChecks("999")));${evaluate(["gate", "custom sentinel"], "failing: gate, custom sentinel")}`,
  );
  expect(released.stdout).toContain("[]");
  expect(released.stderr).toContain(
    "would run a CI-repair pass for: gate, custom sentinel",
  );
});
test("advisory-only final CI parks once with no repair pass", async () => {
  const f = setup();
  const source = `import {evaluateFinalCi} from ${JSON.stringify(convergence)};import {readDriveState} from ${JSON.stringify(storeModule)};${evaluate(["scan"], "failing: scan")}console.log(JSON.stringify((await readDriveState("999")).parked));`;
  const r = await child(f, source);
  expect(r.stdout + r.stderr).toContain('"result":8,"repairs":0');
  expect(r.stdout).toContain('"class":"reviewer-posture"');
  expect(r.stdout).toContain("Fix the finding");
  expect(r.stdout).toContain("Waive it");
  expect(r.stdout).toContain("Leave it to me");
  const twice = await child(f, source);
  expect(twice.stdout).toContain('"result":8,"repairs":0');
  const parks = JSON.parse(twice.stdout.trim().split("\n").at(-1) ?? "null");
  expect(parks).toHaveLength(1);
});
test("mixed advisory failures target repair only at non-advisory failures", async () => {
  const f = setup();
  const r = await child(
    f,
    `import {evaluateFinalCi} from ${JSON.stringify(convergence)};${evaluate(["scan", "test"], "failing: scan, test")}`,
  );
  expect(r.stderr).toContain("would run a CI-repair pass for: test");
  expect(r.stderr).not.toContain("would run a CI-repair pass for: scan");
});
test("excluded reviewer-posture leaves advisory CI policy without effect", async () => {
  const f = setup("autonomy:\n  park_classes: [human-decision]\n");
  const r = await child(
    f,
    `import {evaluateFinalCi} from ${JSON.stringify(convergence)};${evaluate(["scan", "test"], "failing: scan, test")}`,
  );
  expect(r.stderr).toContain("would run a CI-repair pass for: scan, test");
});

test("the checkout cannot add advisory exemptions to the base policy", async () => {
  const f = setup();
  const path = join(f.repoDir, ".config/jig.yaml");
  writeFileSync(
    path,
    (await Bun.file(path).text()).replace(
      "advisory_checks: [scan]",
      "advisory_checks: [scan, test]",
    ),
  );
  const r = await child(
    f,
    `import {evaluateFinalCi} from ${JSON.stringify(convergence)};${evaluate(["scan", "test"], "failing: scan, test")}`,
  );
  expect(r.stderr).toContain("would run a CI-repair pass for: test");
});

test("a recorded advisory waiver stops without repair or certification", async () => {
  const f = setup();
  const at = "2026-11-13T09:00:00.000Z";
  writeState(f.stateDir, "999", {
    ...freshState(999),
    resolvedParks: [
      {
        key: advisoryKey(f.head, ["scan"]),
        kind: "finding",
        class: "reviewer-posture",
        reason: "How should this finding be handled?",
        parkedAt: at,
        resolvedAt: at,
        outcome: "answered",
        answers: [
          {
            author: "owner",
            at,
            url: "https://example.test/answer",
            choice: { option: "waive", recommended: false, form: "choose" },
          },
        ],
      },
    ],
  });
  const r = await child(
    f,
    `import {evaluateFinalCi} from ${JSON.stringify(convergence)};import {readDriveState} from ${JSON.stringify(storeModule)};${evaluate(["scan"], "failing: scan")}console.log(JSON.stringify((await readDriveState("999")).verifiedSha));`,
  );
  expect(r.stdout).toContain('"result":1,"repairs":0');
  expect(r.stdout.trim().split("\n").at(-1)).toBe('""');
  expect(r.stderr).toContain("https://example.test/answer");
  expect(r.stderr).not.toContain("would run a CI-repair pass");
});

test("the CI report marks held failures and restores their repair provenance on release", async () => {
  const f = setup();
  const checks = [
    check("gate", 1, "failure", 0),
    check("custom sentinel", 2, "failure", 0),
  ];
  const held = await report(f, checks);
  expect(held.ci).toBe("held: custom sentinel, gate");
  expect(held.failingCheckNames).toEqual([]);
  await releaseHold(f);
  const released = await report(f, checks);
  expect(released.ci).toBe("failing: custom sentinel, gate");
  expect(released.failingCheckRunNames).toEqual(["custom sentinel", "gate"]);
});

test("a held selected failure does not resurrect failures or hide cancellation", async () => {
  const f = setup();
  const first = check("gate", 1, "failure", 0);
  const held = await report(f, [first, check("gate", 2, "failure", 1)]);
  expect(held.ci).toBe("held: gate");
  expect(held.failingCheckNames).toEqual([]);
  const cancelled = await report(f, [first, check("gate", 2, "cancelled", 1)]);
  expect(cancelled.ci).toBe("cancelled: gate");
});

test("a held selected failure keeps superseded pending and cancelled attempts out of the verdict", async () => {
  const f = setup();
  const latest = check("gate", 2, "failure", 1);
  const pending = await report(f, [
    check("gate", 1, null, 0, "in_progress"),
    latest,
  ]);
  expect(pending.ci).toBe("held: gate");
  expect(pending.failingCheckNames).toEqual([]);
  const cancelled = await report(f, [check("gate", 1, "cancelled", 0), latest]);
  expect(cancelled.ci).toBe("held: gate");
  expect(cancelled.failingCheckNames).toEqual([]);
});

test("a held failure retains cross-name replacement evidence in its later check", async () => {
  const f = setup();
  writeRuns(f, [run(1, "cancelled", 0), run(2, "failure", 1)]);
  const checks = [
    check("test", 1, "failure", 0),
    check("gate", 2, "failure", 1),
  ];
  const ci = await report(f, checks, true);
  expect(ci.ci).toBe("held: gate");
  expect(ci.failingCheckNames).toEqual([]);
});

test("a held failure retains a passing cross-name replacement witness", async () => {
  const f = setup();
  writeRuns(f, [
    run(1, "failure", 0),
    run(2, "cancelled", 1),
    run(3, "success", 2),
    run(4, "skipped", 3),
  ]);
  const checks = [
    check("gate", 1, "failure", 0),
    check("gate", 2, "cancelled", 1),
    check("test", 3, "success", 2),
    check("test", 4, "skipped", 3),
  ];
  const ci = await report(f, checks, true);
  expect(ci.ci).toBe("held: gate");
  expect(ci.failingCheckNames).toEqual([]);
});

test("a later held failure in another group still replaces a cancelled run between held failures", async () => {
  const f = setup();
  writeRuns(f, [
    run(1, "failure", 1),
    run(2, "cancelled", 2),
    run(3, "failure", 3),
  ]);
  const checks = [
    check("gate", 1, "failure", 1),
    check("gate", 2, "cancelled", 2),
    check("custom sentinel", 3, "failure", 3),
  ];
  const ci = await report(f, checks, true);
  expect(ci.ci).toBe("held: custom sentinel, gate");
  expect(ci.failingCheckNames).toEqual([]);
});

test("a held failure leaves an independently rerunning suite pending", async () => {
  const f = setup();
  writeRuns(f, [
    run(1, null, 0, { status: "in_progress", workflowId: 1, attempt: 2 }),
    run(2, "failure", 1, { workflowId: 2 }),
  ]);
  const checks = [
    check("gate", 1, "failure", 0),
    check("gate", 2, "failure", 1),
  ];
  const ci = await report(f, checks, true);
  expect(ci.ci).toBe("pending: gate");
  expect(ci.failingCheckNames).toEqual([]);
});

test("mixed failure provenance excludes advisory-only runs from the repair channel", async () => {
  const f = setup();
  const routing = join(SCRIPTS, "lib/driver/special-ci.ts");
  const channel = join(SCRIPTS, "lib/driver/failed-runs.ts");
  const r = await child(
    f,
    `import {specialCiDisposition} from ${JSON.stringify(routing)};import {failedRunsToTell} from ${JSON.stringify(channel)};const result=await specialCiDisposition("failing: scan, test",false,{pr:"999",dryRun:false},process.env.DRIVE_PR_POLICY_BASE,{checkRunNames:["scan","test"],statusNames:[],runs:[{id:1,createdAt:"2026-11-13T09:00:00Z",jobNames:["scan"]},{id:2,createdAt:"2026-11-13T09:00:00Z",jobNames:["test","scan"]}]},async()=>1);console.log(JSON.stringify(result.failing.runs));console.log(JSON.stringify(await failedRunsToTell("999",result.failing.runs)));`,
  );
  const lines = r.stdout.trim().split("\n");
  expect(JSON.parse(lines[0] ?? "null")).toEqual([]);
  expect(JSON.parse(lines[1] ?? "null")).toEqual([]);
});
