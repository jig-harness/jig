import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { classifyDrive, type DoctorInput } from "../scripts/lib/doctor.ts";

const HEAD = "a".repeat(40);
const root = join(import.meta.dir, "../scripts/lib");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cancelled-recovery-"));
  const overlay = join(dir, "jig.yaml");
  writeFileSync(
    overlay,
    "ci:\n  hold_label: ci:hold\n  required_checks: [gate]\n",
  );
  const source = join(dir, "probe.ts");
  writeFileSync(
    source,
    `
    import { observeCancellation, claimCancellation } from ${JSON.stringify(join(root, "cancelled-recovery-state.ts"))};
    import { recoverCancelledOnHead } from ${JSON.stringify(join(root, "cancelled-recovery-live.ts"))};
    const mode = process.argv[2];
    const head = process.argv[3] || ${JSON.stringify(HEAD)};
    if (mode === "request") { await observeCancellation("5", head); console.log(await claimCancellation("5", head, [10])); process.exit(0); }
    console.log(JSON.stringify(mode === "observe" ? await observeCancellation("5", head) :
      mode === "claim" ? await claimCancellation("5", head) : await recoverCancelledOnHead("5", head)));
  `,
  );
  writeFakeProgram(
    join(dir, "gh"),
    `#!/usr/bin/env bun
    import { readFileSync, existsSync } from "node:fs";
    const phasePath = ${JSON.stringify(join(dir, "phase"))};
    const phase = existsSync(phasePath) ? readFileSync(phasePath, "utf8") : "held";
    const args = process.argv.slice(2);
    if (args[0] === "api" && args.at(-1).includes("check-runs")) {
      console.log(JSON.stringify([{check_runs: [{id: 1, name: "gate", head_sha: ${JSON.stringify(HEAD)},
        status: phase === "pending" ? "in_progress" : "completed", conclusion: phase === "pending" ? null : phase === "success" ? "success" : "cancelled", check_suite: {id: 1}}]}]));
    } else if (args[0] === "api" && args.at(-1).includes("actions/runs")) {
      console.log(JSON.stringify([{workflow_runs: [{id: 1, workflow_id: 10, check_suite_id: 1,
        status: phase === "pending" ? "in_progress" : "completed", conclusion: phase === "pending" ? null : "success",
        created_at: "2026-01-01T00:00:00Z", run_attempt: 2}]}]));
    } else if (args[0] === "pr" && args[1] === "view") {
      console.log(JSON.stringify({state: "OPEN", headRefOid: ${JSON.stringify(HEAD)}, labels: [{name: "ci:hold"}]}));
    } else { console.error("unexpected outbound call " + JSON.stringify(args)); process.exit(2); }
  `,
  );
  const env = {
    ...process.env,
    DRIVE_PR_STATE_DIR: join(dir, "state"),
    JIG_OVERLAY: overlay,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
  };
  const run = async (mode: string, head = HEAD) => {
    const child = Bun.spawn([process.execPath, source, mode, head], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    return JSON.parse(stdout);
  };
  return { dir, run };
}

describe("durable cancellation recovery boundary", () => {
  test("a claim survives process restarts and concurrent claimers only win once per head", async () => {
    const f = fixture();
    try {
      const observation = await f.run("observe");
      expect(observation.requestedAt).toBeNull();
      expect(
        (await Promise.all([f.run("claim"), f.run("claim")])).sort(),
      ).toEqual([false, true]);
      expect(await f.run("claim")).toBe(false);
      expect((await f.run("observe")).requestedAt).toBeNumber();
      await f.run("observe", "b".repeat(40));
      expect(await f.run("claim", "b".repeat(40))).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("intentional cancellations under a live hold do not request recovery or park", async () => {
    const f = fixture();
    try {
      expect(await f.run("live")).toBe("none");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a requested rerun keeps polling after pending jobs replace the cancelled check", async () => {
    const f = fixture();
    try {
      expect(await f.run("request")).toBe(true);
      writeFileSync(join(f.dir, "phase"), "pending");
      expect(await f.run("live")).toBe("wait");
      writeFileSync(join(f.dir, "phase"), "success");
      expect(await f.run("live")).toBe("none");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

test("doctor names cancelled-run recovery instead of stopping a wedged driver", () => {
  const recovery = "Inspect cancelled run 42; gh run rerun 42";
  const input: DoctorInput = {
    lockState: "live",
    progressAgeMs: 60_000_000,
    stateReadable: true,
    passChild: false,
    quotaPark: null,
    parkedCount: 1,
    cancelledCiRecovery: recovery,
    leftovers: null,
    stallThresholdMs: 60_000,
    pr: "5",
    worktreePath: "/tree",
    selfPath: "/drives.ts",
    hostIsLocal: true,
  };
  expect(classifyDrive(input, new Date()).recovery).toBe(recovery);
  expect(
    classifyDrive({ ...input, progressAgeMs: 1 }, new Date()).recovery,
  ).toBe(recovery);
});
