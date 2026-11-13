import { writeState } from "./state-rows.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { advisoryKey } from "../scripts/lib/driver/advisory-ci.ts";
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
  const view = await Bun.file(join(f.dir, "pr-view.json")).json();
  view.labels = [];
  writeFileSync(join(f.dir, "pr-view.json"), JSON.stringify(view));
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
  const evidence = join(SCRIPTS, "lib/status/evidence.ts");
  const source = `import {ciReportFor} from ${JSON.stringify(evidence)};const runs=["gate","custom sentinel"].map((name,i)=>({name,id:i+1,status:"completed",conclusion:"failure",app:"github-actions",title:"",started:"2026-11-13T09:00:00Z"}));console.log(JSON.stringify(await ciReportFor("example-org","example-repo",process.env.DRIVE_PR_POLICY_BASE,runs,false,"999")));`;
  const held = JSON.parse((await child(f, source)).stdout);
  expect(held.ci).toBe("held: custom sentinel, gate");
  expect(held.failingCheckNames).toEqual([]);
  const path = join(f.dir, "pr-view.json");
  const view = await Bun.file(path).json();
  view.labels = [];
  writeFileSync(path, JSON.stringify(view));
  const released = JSON.parse((await child(f, source)).stdout);
  expect(released.ci).toBe("failing: custom sentinel, gate");
  expect(released.failingCheckRunNames).toEqual(["custom sentinel", "gate"]);
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
  expect(JSON.parse(lines[0] ?? "null")).toEqual([
    { id: 2, createdAt: "2026-11-13T09:00:00Z", jobNames: ["test"] },
  ]);
  expect(JSON.parse(lines[1] ?? "null")).toEqual([2]);
});
