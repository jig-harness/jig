/**
 * drive-pr suite: drive.ts's final status re-read after convergence — it reads
 * with the drive's own view, a disagreement that persists on one head stops the
 * drive instead of re-gating forever, and a failed CI-hold release says why.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  binDir,
  scratchClean,
  writeFixture as rawFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { PASS_NOOP, spawnDriveIn } from "./drive-loop-harness.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

const writeFixture = (f: Parameters<typeof rawFixture>[0]) =>
  rawFixture(f, scratchClean.dir);

useDrivePrSuite();

/** A drive that has not ended by then loops, which is what these tests catch. */
const DRIVE_DEADLINE_MS = 45_000;

/**
 * A `gh` in front of the fixture's that finds which drive step called it by
 * walking up its process's ancestors (`/proc` where there is one, else `ps`): under the final re-read (the
 * `drive-status.ts` call that carries `--once`) it answers from the fixture in
 * `$REREAD_FIXTURES`, and under the CI hold's release it kills that release, as
 * a stop from outside does, when `$KILL_RELEASE` is set.
 */
const ANCESTOR_GH = `#!/bin/sh
args_of() {
  if [ -r "/proc/$1/cmdline" ]; then tr '\\0' ' ' < "/proc/$1/cmdline"
  else ps -o args= -p "$1"; fi
}
parent_of() {
  if [ -r "/proc/$1/status" ]; then sed -n 's/^PPid:[[:space:]]*//p' "/proc/$1/status"
  else ps -o ppid= -p "$1" | tr -d ' '; fi
}
pid=$PPID
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  args=$(args_of "$pid") || break
  case "$args" in
    *drive-status.ts*--once*)
      if [ -n "$REREAD_FIXTURES" ]; then
        DRIVE_PR_FIXTURES=$REREAD_FIXTURES
        export DRIVE_PR_FIXTURES
      fi
      break ;;
    *"ci-hold.ts release"*)
      if [ -n "$KILL_RELEASE" ]; then
        kill -KILL "$pid"
        exit 1
      fi
      break ;;
    */drive.ts" "*) break ;;
  esac
  pid=$(parent_of "$pid")
done
exec "$REAL_GH" "$@"
`;

let ghSeq = 0;
function ancestorGh(): string {
  const bin = join(binDir, "..", `ancestor-gh-${++ghSeq}`);
  mkdirSync(bin, { recursive: true });
  writeFakeProgram(join(bin, "gh"), ANCESTOR_GH);
  return bin;
}

/** Run drive.ts to its end, or stop it at the deadline and say so. */
async function driveUntilEnd(
  dir: string,
  stateDir: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number | null; stderr: string; stopped: boolean }> {
  const proc = spawnDriveIn(dir, stateDir, args, undefined, {
    env: { REAL_GH: join(binDir, "gh"), ...env },
    extraBinDir: ancestorGh(),
  });
  const stderrText = new Response(proc.stderr).text();
  let stopped = false;
  const deadline = Date.now() + DRIVE_DEADLINE_MS;
  while (proc.exitCode === null && proc.signalCode === null) {
    if (Date.now() >= deadline) {
      stopped = true;
      proc.kill("SIGTERM");
      break;
    }
    await Bun.sleep(100);
  }
  await proc.exited;
  return { exitCode: proc.exitCode, stderr: await stderrText, stopped };
}

const REGATE = "re-gating";

/** A pass whose command carries `--bots-only`, as the drive requires of one. */
const PASS_BOTS_ONLY = [
  "sh",
  "-c",
  'echo "pass for 999 --bots-only: RAN_TH""E_PASS" >&2; exit 0',
];

/** Fail with the driver's own log when the deadline had to stop it. */
function expectEnded(r: { stopped: boolean; stderr: string }): void {
  if (r.stopped)
    throw new Error(
      `drive.ts was still running at the deadline:\n${r.stderr.slice(-6000)}`,
    );
}

describe.skipIf(
  skipsOnWindows(
    "process-lifecycle",
    "the fake gh reads its callers through ps",
  ),
)("drive.ts's final status re-read", () => {
  it(
    "reads with the drive's --bots-only view, so a person's open thread does not re-gate",
    async () => {
      const { dir, stateDir } = writeFixture({
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        threads: [
          {
            id: "PRRT_person",
            path: "a.ts",
            bot: false,
            comments: [
              {
                author: "example-person",
                authorAssociation: "MEMBER",
                body: "a question for the author",
                bot: false,
              },
            ],
          },
        ],
      });
      const r = await driveUntilEnd(
        dir,
        stateDir,
        [
          "--bots-only",
          "--no-head-sync",
          "--keep-draft",
          "--",
          ...PASS_BOTS_ONLY,
        ],
        {},
      );
      expectEnded(r);
      expectSpawnExit(
        { exitCode: r.exitCode, stdout: null, stderr: r.stderr },
        0,
      );
      expect(r.stderr).not.toContain(REGATE);
      expect(r.stderr).not.toContain("RAN_THE_PASS");
    },
    DRIVE_DEADLINE_MS * 2,
  );

  it(
    "re-gates on a new finding the re-read sees up to the limit, then stops naming what it saw",
    async () => {
      const gate = writeFixture({
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        threads: [],
      });
      const reread = writeFixture({
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        threads: [{ id: "PRRT_new", path: "a.ts", bot: true }],
      });
      const r = await driveUntilEnd(
        gate.dir,
        gate.stateDir,
        ["--no-head-sync", "--keep-draft", "--", ...PASS_NOOP],
        { REREAD_FIXTURES: reread.dir, DRIVE_PR_FINAL_REGATE_LIMIT: "2" },
      );
      expectEnded(r);
      expectSpawnExit(
        { exitCode: r.exitCode, stdout: null, stderr: r.stderr },
        1,
      );
      // The limit's edge: two re-gates run, the third disagreement stops.
      const regates = r.stderr
        .split("\n")
        .filter((line) => line.includes(REGATE));
      expect(regates).toHaveLength(2);
      for (const line of regates) expect(line).toContain("ROUND_READY");
      expect(r.stderr).toContain(
        "the final status re-read disagreed with the round gate",
      );
      expect(r.stderr).toContain("the re-read saw ROUND_READY");
      expect(r.stderr).toContain("DRIVE_PR_FINAL_REGATE_LIMIT=2");
      expect(r.stderr).not.toContain("converged after");
    },
    DRIVE_DEADLINE_MS * 2,
  );

  it(
    "continues convergence after a timeout verifying CI hold removal",
    async () => {
      const { dir, stateDir } = writeFixture({
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        threads: [],
        ciHeld: true,
      });
      writeFileSync(
        join(dir, "timeline.json"),
        JSON.stringify([
          {
            node_id: "LE_1",
            event: "labeled",
            label: { name: "ci:hold" },
            actor: { login: "drive-user" },
            created_at: "2026-09-10T09:59:00Z",
          },
        ]),
      );
      writeFileSync(join(dir, "timeline-timeout-after-unlabel"), "");
      const r = await driveUntilEnd(
        dir,
        stateDir,
        ["--no-head-sync", "--keep-draft", "--", ...PASS_NOOP],
        {},
      );
      expectEnded(r);
      expectSpawnExit(
        { exitCode: r.exitCode, stderr: r.stderr, stdout: null },
        0,
      );
      expect(r.stderr).toContain("simulated proof timeline timeout");
      expect(r.stderr).toContain("Waiting to verify the CI hold label removal");
    },
    DRIVE_DEADLINE_MS * 2,
  );

  it(
    "continues convergence after consecutive timeouts verifying CI hold removal",
    async () => {
      const { dir, stateDir } = writeFixture({
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        threads: [],
        ciHeld: true,
      });
      writeFileSync(
        join(dir, "timeline.json"),
        JSON.stringify([
          {
            node_id: "LE_1",
            event: "labeled",
            label: { name: "ci:hold" },
            actor: { login: "drive-user" },
            created_at: "2026-09-10T09:59:00Z",
          },
        ]),
      );
      writeFileSync(join(dir, "timeline-timeout-after-unlabel-count"), "2");
      const r = await driveUntilEnd(
        dir,
        stateDir,
        ["--no-head-sync", "--keep-draft", "--", ...PASS_NOOP],
        {},
      );
      expectEnded(r);
      expectSpawnExit(
        { exitCode: r.exitCode, stderr: r.stderr, stdout: null },
        0,
      );
      expect(
        r.stderr.match(/Waiting to verify the CI hold label removal/g),
      ).toHaveLength(2);
    },
    DRIVE_DEADLINE_MS * 3,
  );

  it(
    "stops after the configured consecutive timeouts verifying CI hold removal",
    async () => {
      const { dir, stateDir } = writeFixture({
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        threads: [],
        ciHeld: true,
      });
      writeFileSync(
        join(dir, "timeline.json"),
        JSON.stringify([
          {
            node_id: "LE_1",
            event: "labeled",
            label: { name: "ci:hold" },
            actor: { login: "drive-user" },
            created_at: "2026-09-10T09:59:00Z",
          },
        ]),
      );
      writeFileSync(join(dir, "timeline-timeout-after-unlabel-count"), "2");
      const r = await driveUntilEnd(
        dir,
        stateDir,
        ["--no-head-sync", "--keep-draft", "--", ...PASS_NOOP],
        { DRIVE_PR_RELEASE_PROOF_ATTEMPTS: "1" },
      );
      expectEnded(r);
      expectSpawnExit(
        { exitCode: r.exitCode, stderr: r.stderr, stdout: null },
        1,
      );
      expect(
        r.stderr.match(/Waiting to verify the CI hold label removal/g),
      ).toHaveLength(1);
      expect(r.stderr).toContain(
        "CI hold removal is still unproven after 2 consecutive read(s)",
      );
      expect(r.stderr).toContain("DRIVE_PR_RELEASE_PROOF_ATTEMPTS=1");
    },
    DRIVE_DEADLINE_MS * 2,
  );

  it(
    "continues convergence when a recovery snapshot fails after its entry check succeeds",
    async () => {
      const { dir, stateDir } = writeFixture({
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        threads: [],
        ciHeld: true,
      });
      writeFileSync(
        join(dir, "timeline.json"),
        JSON.stringify([
          {
            node_id: "LE_1",
            event: "labeled",
            label: { name: "ci:hold" },
            actor: { login: "drive-user" },
            created_at: "2026-09-10T09:59:00Z",
          },
        ]),
      );
      writeFileSync(join(dir, "pr-snapshot-timeout-after-unlabel"), "");
      const r = await driveUntilEnd(
        dir,
        stateDir,
        ["--no-head-sync", "--keep-draft", "--", ...PASS_NOOP],
        {},
      );
      expectEnded(r);
      expectSpawnExit(
        { exitCode: r.exitCode, stderr: r.stderr, stdout: null },
        0,
      );
      expect(r.stderr).toContain("simulated recovery snapshot timeout");
      expect(
        r.stderr.match(/Waiting to verify the CI hold label removal/g),
      ).toHaveLength(1);
    },
    DRIVE_DEADLINE_MS * 2,
  );

  it(
    "logs why the CI hold's release failed when it exits with nothing on stderr",
    async () => {
      const { dir, stateDir } = writeFixture({
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        threads: [],
        ciHeld: true,
      });
      const r = await driveUntilEnd(
        dir,
        stateDir,
        ["--no-head-sync", "--keep-draft", "--", ...PASS_NOOP],
        { KILL_RELEASE: "1" },
      );
      expectEnded(r);
      expectSpawnExit(
        { exitCode: r.exitCode, stdout: null, stderr: r.stderr },
        1,
      );
      expect(r.stderr).toContain("releasing the CI hold label failed (exit 1)");
      expect(r.stderr).toContain("ci-hold.ts release printed no error");
      expect(r.stderr).toContain(
        `release 999 --expect-head ${scratchClean.head}`,
      );
    },
    DRIVE_DEADLINE_MS * 2,
  );
});
