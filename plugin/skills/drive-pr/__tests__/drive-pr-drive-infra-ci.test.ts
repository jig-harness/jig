/**
 * drive-pr suite: drive.ts on a converged head whose failing checks failed on
 * the infrastructure. Such a failure is re-run, or the head moved when the
 * run cannot be re-run, and spends no CI-repair pass; past the bounds the
 * drive stops `CI_INFRA_PERSISTED`. A failing check whose log prints a code
 * error still spends a repair pass, as before.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  CI_INFRA_PERSISTED_EXIT,
  CI_REPAIR_SPENT_EXIT,
} from "../scripts/lib/driver/settings.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { realGitForShell } from "./round-plan-fixtures.ts";
import {
  type CheckRunFixture,
  DORMANT_ARM,
  gitCleanEnv,
  REVIEWER_RUN,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDriveIn, skipLongDriveFixture } from "./drive-loop-harness.ts";

const exits = (r: { stderr: string; exitCode: number }, code: number) =>
  expectSpawnExit({ ...r, stdout: null }, code);

useDrivePrSuite();

/** A real failed run's log, trimmed: both jobs' tool download answered 504. */
const DOWNLOAD_504 = readFileSync(
  join(
    import.meta.dir,
    "../../../shared/__tests__/fixtures/ci-infra/tool-download-504.log",
  ),
  "utf8",
);

/** The same two jobs failing on a code error instead. */
const CODE_ERROR = ["Analyze (python)", "Analyze (actions)"]
  .map(
    (job) =>
      `${job}\tRun tests\t2026-11-08T10:12:19.0000000Z FAIL src/cart/total.test.ts\n${job}\tRun tests\t2026-11-08T10:12:20.0000000Z ##[error]Process completed with exit code 1.`,
  )
  .join("\n");

const OPENED = "2026-09-10T10:00:00Z";

const PASS_RUNS = [
  "sh",
  "-c",
  'echo "pass for 999: RAN_TH""E_PASS TASK=$DRIVE_PR_ROUND_TASK RUNS=[$DRIVE_PR_ROUND_FAILED_RUNS]" >&2; exit 0',
];

const failed = (name: string): CheckRunFixture => ({
  name,
  status: "completed",
  conclusion: "failure",
  app: "github-actions",
  started: OPENED,
  completed_at: OPENED,
  check_suite: { id: 41 },
});

/** The consumer configuration of a repository with required checks and no hold. */
function noHoldOverlay(dir: string, retry = true): string {
  const overlay = join(dir, "no-hold.yaml");
  writeFileSync(
    overlay,
    [
      "repository:",
      "  base_branch: develop",
      "review:",
      '  bots: ["review-bot[bot]"]',
      "  reviewer_app: example-review",
      "ci:",
      `  rerun_failed_once: ${retry}`,
      "  required_checks: [code-quality-and-build, tests, Schema gate]",
      "",
    ].join("\n"),
  );
  return overlay;
}

/**
 * A copy of the scratch clone whose `origin` is a local repository holding the
 * base `develop` and the default branch `main`, so the driver reads a base
 * policy before it retries a check; a `git` stub answers the forge URL that
 * the pull request's repository check expects.
 */
function policyReadableTree(
  dir: string,
  retry: boolean,
): { tree: string; bin: string } {
  const tree = join(dir, "tree");
  cpSync(scratchClean.dir, tree, { recursive: true });
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      env: gitCleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(
      {
        exitCode: r.exitCode,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
      },
      0,
      `git ${args.join(" ")}`,
    );
  };
  const remote = join(dir, "remote", "example-org", "example-repo.git");
  mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare");
  if (retry) git(tree, "push", "-q", remote, "HEAD:refs/heads/develop");
  else {
    // The setting is read from the base branch, so the base commit carries it.
    git(tree, "checkout", "-q", "-b", "base-policy");
    mkdirSync(join(tree, ".config"), { recursive: true });
    writeFileSync(
      join(tree, ".config", "jig.yaml"),
      "ci:\n  rerun_failed_once: false\n",
    );
    git(tree, "add", ".config/jig.yaml");
    git(tree, "commit", "-qm", "base policy", "--no-verify");
    git(tree, "push", "-q", remote, "HEAD:refs/heads/develop");
    git(tree, "checkout", "-q", "--detach", "HEAD~1");
    git(tree, "branch", "-q", "-D", "base-policy");
  }
  git(tree, "push", "-q", remote, "HEAD:refs/heads/main");
  git(tree, "remote", "add", "origin", remote);
  git(tree, "fetch", "-q", "origin");
  git(
    tree,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  const bin = join(dir, "git-bin");
  mkdirSync(bin, { recursive: true });
  writeFakeProgram(
    join(bin, "git"),
    `#!/usr/bin/env sh
if [ "\${*#*remote get-url }" = "origin" ]; then
  echo https://github.com/example-org/example-repo.git
  exit 0
fi
exec "${realGitForShell()}" "$@"
`,
  );
  return { tree, bin };
}

/** Drive a converged head whose two code-scanning checks failed in run 41, with that run's log. */
async function driveFailedScan(
  log: string,
  opts: {
    refused?: boolean;
    persistent?: boolean;
    delayed?: boolean;
    retry?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  const { dir, stateDir } = writeFixture(
    {
      threads: [],
      head: scratchClean.head,
      reviewedSha: scratchClean.head,
      checkRuns: [
        REVIEWER_RUN,
        DORMANT_ARM,
        failed("Analyze (python)"),
        failed("Analyze (actions)"),
      ],
    },
    scratchClean.dir,
  );
  writeFileSync(
    join(dir, "workflow-runs.json"),
    JSON.stringify({
      workflow_runs: [
        {
          id: 41,
          workflow_id: 7,
          event: "dynamic",
          status: "completed",
          conclusion: "failure",
          check_suite_id: 41,
          created_at: OPENED,
          run_started_at: OPENED,
        },
      ],
    }),
  );
  writeFileSync(join(dir, "run-41.log"), log);
  if (opts.refused === true) writeFileSync(join(dir, "rerun-refused"), "");
  if (opts.persistent === true)
    writeFileSync(join(dir, "rerun-still-failing"), "");
  if (opts.delayed === true)
    writeFileSync(join(dir, "retry-witness-sequence"), "");
  const { tree, bin } = policyReadableTree(dir, opts.retry !== false);
  const r = await runDriveIn(
    dir,
    stateDir,
    ["--keep-draft", "--no-head-sync", "--", ...PASS_RUNS],
    tree,
    {
      env: { JIG_OVERLAY: noHoldOverlay(dir, opts.retry), ...opts.env },
      extraBinDir: bin,
    },
  );
  const reruns = existsSync(join(dir, "reruns.log"))
    ? readFileSync(join(dir, "reruns.log"), "utf8").trim().split("\n")
    : [];
  return { ...r, reruns };
}

function expectNoRepairPass(stderr: string): void {
  expect(stderr).not.toContain("RAN_THE_PASS");
  expect(stderr).not.toContain("Running CI-repair pass");
}

describe.skipIf(skipLongDriveFixture)(
  "drive.ts on checks that failed on the infrastructure",
  () => {
    it("re-runs a run whose only failures are a 504 tool download, spending no repair pass", async () => {
      const r = await driveFailedScan(DOWNLOAD_504, {
        env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
      });
      exits(r, 0);
      expect(r.reruns).toEqual(["41"]);
      expect(r.stderr).toContain(
        "every failing check failed on the infrastructure",
      );
      expect(r.stderr).toContain("Re-ran the failed jobs of run(s) 41");
      expectNoRepairPass(r.stderr);
    });

    it("stops CI_INFRA_PERSISTED when the run cannot be re-run and no head move is left, spending no repair pass", async () => {
      const r = await driveFailedScan(DOWNLOAD_504, {
        refused: true,
        env: {
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
          DRIVE_PR_CI_INFRA_HEAD_MOVES: "0",
        },
      });
      exits(r, CI_INFRA_PERSISTED_EXIT);
      expect(r.reruns).toEqual(["41"]);
      expect(r.stderr).toContain("the forge refused to re-run it");
      expect(r.stderr).toContain(
        `The infrastructure failure persisted: exit ${CI_INFRA_PERSISTED_EXIT}, CI_INFRA_PERSISTED`,
      );
      expectNoRepairPass(r.stderr);
    });

    it("retries a code check once without spending a repair pass when it passes", async () => {
      const r = await driveFailedScan(CODE_ERROR, {
        env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
      });
      exits(r, 0);
      expect(r.reruns).toEqual(["41"]);
      expect(r.stderr).toContain("retry 1/1, no repair pass spent");
      expectNoRepairPass(r.stderr);
    });

    it("spends a repair pass after the same code check fails its one retry", async () => {
      const r = await driveFailedScan(CODE_ERROR, {
        persistent: true,
        env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
      });
      exits(r, CI_REPAIR_SPENT_EXIT);
      expect(r.reruns).toEqual(["41"]);
      expect(r.stderr).toContain("Not an infrastructure failure");
      expect(r.stderr).toContain("Running CI-repair pass 1/1");
      expect(r.stderr).toContain("TASK=ci-repair RUNS=[41]");
    });

    it("waits for a newer completed retry even when the aggregate already reads green", async () => {
      const r = await driveFailedScan(CODE_ERROR, {
        delayed: true,
        env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
      });
      exits(r, 0);
      expect(r.reruns).toEqual(["41"]);
      expect(r.stderr).toContain("Waiting for retry of run 41");
      expectNoRepairPass(r.stderr);
    });

    it("can disable the code-check retry independently of repairs", async () => {
      const r = await driveFailedScan(CODE_ERROR, {
        retry: false,
        env: { DRIVE_PR_CI_REPAIR_ROUNDS: "1" },
      });
      exits(r, CI_REPAIR_SPENT_EXIT);
      expect(r.reruns).toEqual([]);
      expect(r.stderr).toContain("Running CI-repair pass 1/1");
    });
  },
);
