import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import {
  recoveryExit,
  recoveryLabel,
} from "../scripts/lib/cancelled-recovery-reads.ts";
import { classifyDrive, type DoctorInput } from "../scripts/lib/doctor.ts";

const HEAD = "a".repeat(40);
const root = join(import.meta.dir, "../scripts/lib");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cancelled-recovery-"));
  const overlay = join(dir, "jig.yaml");
  writeFileSync(
    overlay,
    "ci:\n  hold_label: ci:hold\n  required_checks: [gate]\ndispatch:\n  person: drive-user\n",
  );
  const source = join(dir, "probe.ts");
  writeFileSync(
    source,
    `
    import { observeCancellation, claimCancellation, claimLabelRerun, withdrawCancellation, withdrawLabelRerun } from ${JSON.stringify(join(root, "cancelled-recovery-state.ts"))};
    import { recoverCancelledOnHead } from ${JSON.stringify(join(root, "cancelled-recovery-live.ts"))};
    import { driveDb } from ${JSON.stringify(join(root, "state/db.ts"))};
    import { resolveStateDir } from ${JSON.stringify(join(root, "state/store.ts"))};
    const mode = process.argv[2];
    const head = process.argv[3] || ${JSON.stringify(HEAD)};
    if (mode === "request") { await observeCancellation("5", head); console.log(await claimCancellation("5", head, [10])); process.exit(0); }
    if (mode === "refused") {
      await observeCancellation("5", head);
      const refusal = await claimCancellation("5", head, [10], [], async () => { throw new Error("lost"); }).then(() => "claimed", (err) => err.message);
      console.log(JSON.stringify(refusal));
      process.exit(0);
    }
    if (mode === "stale-withdraw") {
      const named = [{ id: 1, workflowId: 10, attempt: 1, at: 1 }];
      await observeCancellation("5", head);
      await claimCancellation("5", head, [10], named);
      await withdrawCancellation("5", head, [{ ...named[0], id: 2 }], [], true);
      console.log(JSON.stringify((await observeCancellation("5", head)).requestedRuns));
      process.exit(0);
    }
    if (mode === "label-withdraw") {
      const run = { id: 7, attempt: 1 };
      const first = await claimLabelRerun("5", run);
      await withdrawLabelRerun("5", run);
      console.log(JSON.stringify([first, await claimLabelRerun("5", run)]));
      process.exit(0);
    }
    if (mode === "parked") {
      const { openStore } = await import(${JSON.stringify(join(root, "state/store.ts"))});
      console.log(JSON.stringify((await openStore("5")).read().state.parked.map((p) => p.key)));
      process.exit(0);
    }
    if (mode === "spent") {
      await observeCancellation("5", head);
      const drive = driveDb(await resolveStateDir());
      drive.db.run("UPDATE cancelled_ci SET first_seen = first_seen - 900000, requested_at = first_seen - 900000");
      process.exit(0);
    }
    if (mode === "before-pass") {
      const { recoverBeforePass } = await import(${JSON.stringify(join(root, "driver/round-step.ts"))});
      const recovery = JSON.parse(process.env.PROBE_RECOVERY ?? "null");
      console.log(JSON.stringify(await recoverBeforePass({ pr: "5", dryRun: false }, 0, { head: { api: head } }, async () => recovery)));
      process.exit(0);
    }
    if (mode === "past-grace") {
      await observeCancellation("5", head);
      const drive = driveDb(await resolveStateDir());
      drive.db.run("UPDATE cancelled_ci SET first_seen = first_seen - 60000");
      process.exit(0);
    }
    console.log(JSON.stringify(mode === "observe" ? await observeCancellation("5", head) :
      mode === "claim" ? await claimCancellation("5", head) :
      mode === "fenced" ? await recoverCancelledOnHead("5", head, undefined, true) : await recoverCancelledOnHead("5", head)));
  `,
  );
  writeFakeProgram(
    join(dir, "gh"),
    `#!/usr/bin/env bun
    import { appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
    const phasePath = ${JSON.stringify(join(dir, "phase"))};
    const phase = existsSync(phasePath) ? readFileSync(phasePath, "utf8") : "held";
    // Phases with a cancelled gate the runner stopped at its limit, or (concurrency) did not.
    const STOPPED = ["timeout", "paged", "concurrency", "mixed", "rerunning", "garbled"];
    const args = process.argv.slice(2);
    const failPath = ${JSON.stringify(join(dir, "fail"))};
    if (existsSync(failPath)) {
      const fail = JSON.parse(readFileSync(failPath, "utf8"));
      if (args.join(" ").includes(fail.match)) {
        appendFileSync(${JSON.stringify(join(dir, "calls"))}, "x");
        if (fail.passes > 0) {
          writeFileSync(failPath, JSON.stringify({ ...fail, passes: fail.passes - 1 }));
        } else if (fail.times > 0) {
          writeFileSync(failPath, JSON.stringify({ ...fail, times: fail.times - 1 }));
          if (fail.hangs) await Bun.sleep(30_000);
          console.error(fail.stderr);
          process.exit(1);
        }
      }
    }
    if (args[0] === "run" && args[1] === "rerun") {
      appendFileSync(${JSON.stringify(join(dir, "reruns"))}, args[2] + "\\n");
    } else if (args[0] === "api" && args.at(-1).includes("timeline")) {
      console.log("[[]]");
    } else if (args[0] === "api" && args.at(-1).includes("/annotations")) {
      const message = phase === "concurrency"
        ? "Canceling since a higher priority waiting request for 'ci-refs/pull/5' exists"
        : "The job running on runner r1 has exceeded the maximum execution time of 30 minutes.";
      const onPage = args.at(-1).includes("page=2") ? 2 : 1;
      const filler = Array.from({length: 100}, () => ({annotation_level: "notice", message: "step output"}));
      console.log(JSON.stringify(phase === "garbled" ? { message: "Not Found" } : phase === "paged" ? (onPage === 1 ? filler : [{annotation_level: "failure", message}]) : [{ annotation_level: "failure", message }]));
    } else if (args[0] === "api" && args.at(-1).includes("check-runs")) {
      const stopped = STOPPED.includes(phase);
      const lint = {id: 3, name: "lint", head_sha: ${JSON.stringify(HEAD)}, status: "completed", conclusion: "cancelled", check_suite: {id: 3}};
      const checks = stopped ? [{id: 1, name: "gate", head_sha: ${JSON.stringify(HEAD)}, status: "completed", conclusion: "cancelled", check_suite: {id: 1},
        started_at: "2026-01-01T00:00:00Z", completed_at: phase === "concurrency" ? "2026-01-01T00:02:00Z" : "2026-01-01T00:30:04Z", output: {annotations_count: 1}},
        ...(phase === "mixed" ? [lint] : [])]
        : phase === "external" ? [{id: 2, name: "reviewer", head_sha: ${JSON.stringify(HEAD)}, status: "completed", conclusion: "cancelled", check_suite: {id: 2}}] : [{id: 1, name: "gate", head_sha: ${JSON.stringify(HEAD)},
        status: phase === "pending" ? "in_progress" : "completed", conclusion: phase === "pending" ? null : phase === "success" ? "success" : "cancelled", check_suite: {id: 1}}];
      console.log(JSON.stringify([{check_runs: checks}]));
    } else if (args[0] === "api" && args.at(-1).includes("actions/runs")) {
      if (phase === "unreadable") process.exit(1);
      const going = phase === "pending" || phase === "rerunning";
      const runs = phase === "external" ? [] : [{id: 1, workflow_id: 10, check_suite_id: 1,
        status: going ? "in_progress" : "completed", conclusion: going ? null : ["orphaned", ...STOPPED].includes(phase) ? "cancelled" : "success",
        created_at: "2026-01-01T00:00:00Z", run_attempt: 2},
        ...(phase === "mixed" ? [{id: 3, workflow_id: 30, check_suite_id: 3, status: "completed", conclusion: "cancelled", created_at: "2026-01-01T00:00:00Z", run_attempt: 1}] : [])];
      console.log(JSON.stringify([{workflow_runs: runs}]));
    } else if (args[0] === "pr" && args[1] === "view") {
      console.log(JSON.stringify({state: "OPEN", headRefOid: ${JSON.stringify(HEAD)}, labels: ["external", "unreadable", "orphaned", ...STOPPED].includes(phase) ? [] : [{name: "ci:hold"}]}));
    } else { console.error("unexpected outbound call " + JSON.stringify(args)); process.exit(2); }
  `,
  );
  const env = {
    ...process.env,
    DRIVE_PR_STATE_DIR: join(dir, "state"),
    DRIVE_PR_RECOVERY_READ_RETRY_MS: "10",
    HOME: dir,
    JIG_FORGE_BUDGET: "off",
    JIG_OVERLAY: overlay,
    PATH: `${dir}${delimiter}${process.env.PATH}`,
  };
  let lastStderr = "";
  const run = async (
    mode: string,
    head = HEAD,
    extraEnv: Record<string, string> = {},
  ) => {
    const child = Bun.spawn([process.execPath, source, mode, head], {
      env: { ...env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    lastStderr = stderr;
    return stdout === "" ? null : JSON.parse(stdout);
  };
  /** The forge fails the next `times` calls whose arguments hold `match`. */
  const failReads = (
    match: string,
    times: number,
    stderr: string,
    { hangs = false, passes = 0, phase = "external" } = {},
  ) => {
    writeFileSync(join(dir, "phase"), phase);
    writeFileSync(
      join(dir, "fail"),
      JSON.stringify({ match, times, stderr, hangs, passes }),
    );
  };
  const calls = () => readFileSync(join(dir, "calls"), "utf8").length;
  const reruns = () =>
    existsSync(join(dir, "reruns"))
      ? readFileSync(join(dir, "reruns"), "utf8").trim().split("\n")
      : [];
  return { dir, run, failReads, calls, reruns, stderr: () => lastStderr };
}

const BAD_GATEWAY = "gh: HTTP 502: Bad Gateway";

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

  test("a withdrawal leaves a claim another caller has moved", async () => {
    const f = fixture();
    try {
      expect(await f.run("stale-withdraw")).toEqual([
        { id: 1, workflowId: 10, attempt: 1, at: 1 },
      ]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a withdrawn label-caused claim can be claimed again", async () => {
    const f = fixture();
    try {
      expect(await f.run("label-withdraw")).toEqual([true, true]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a claim refused by its commit check is not spent", async () => {
    const f = fixture();
    try {
      expect(await f.run("refused")).toBe("lost");
      expect(await f.run("claim")).toBe(true);
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

  test("keeps cancellation recovery unknown when workflow provenance cannot be read", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, "phase"), "unreadable");
      expect(await f.run("live")).toBe("unknown");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("ignores a cancelled external check that no Actions workflow owns", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, "phase"), "external");
      expect(await f.run("live")).toBe("none");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe("a cancelled-run recovery read that fails", () => {
  const reads = [
    ["check runs", "check-runs"],
    ["pull request and CI hold", "pr view"],
    ["workflow runs", "actions/runs"],
  ] as const;

  for (const [read, match] of reads) {
    test(`the ${read} read is asked once more and the recovery goes on`, async () => {
      const f = fixture();
      try {
        f.failReads(match, 1, BAD_GATEWAY);
        expect(await f.run("live")).toBe("none");
        expect(f.calls()).toBe(2);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });

    test(`the ${read} read that keeps failing is named with its class`, async () => {
      const f = fixture();
      try {
        f.failReads(match, 9, BAD_GATEWAY);
        const answer = await f.run("live");
        expect(answer).toMatchObject({ read, class: "server-fault" });
        expect(answer.reason).toContain("HTTP 502");
        expect(f.calls()).toBe(2);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });
  }

  test("a read past its deadline is named as too costly", async () => {
    const f = fixture();
    try {
      f.failReads("actions/runs", 9, BAD_GATEWAY, { hangs: true });
      expect(await f.run("live", HEAD, { GH_CALL_TIMEOUT: "1" })).toMatchObject(
        { read: "workflow runs", class: "too-costly" },
      );
      expect(f.calls()).toBe(2);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  // The hold read comes first, then the check before the claim, the request's
  // own check, and the last one before the re-run.
  for (const [where, passes] of [
    ["the request's own check", 2],
    ["the last check before the re-run", 3],
  ] as const) {
    test(`a failure at ${where} gives the claim back for the re-armed drive`, async () => {
      const f = fixture();
      try {
        await f.run("past-grace");
        f.failReads("pr view", 2, BAD_GATEWAY, { passes, phase: "orphaned" });
        expect(await f.run("fenced")).toMatchObject({
          read: "pull request and CI hold",
          class: "server-fault",
        });
        expect(f.reruns()).toEqual([]);
        expect((await f.run("observe")).requestedAt).toBeNull();
        expect(await f.run("fenced")).toBe("wait");
        expect(f.reruns()).toEqual(["1"]);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });
  }

  test("an unreadable answer at the last check before the re-run is not a failed re-run", async () => {
    const f = fixture();
    try {
      await f.run("past-grace");
      f.failReads("pr view", 1, "gh: HTTP 401: Bad credentials", {
        passes: 3,
        phase: "orphaned",
      });
      expect(await f.run("fenced")).toBe("unknown");
      expect(f.reruns()).toEqual([]);
      expect((await f.run("observe")).requestedAt).toBeNull();
      expect(await f.run("fenced")).toBe("wait");
      expect(f.reruns()).toEqual(["1"]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a rate limit is not asked again before it clears", async () => {
    const f = fixture();
    try {
      f.failReads("actions/runs", 9, "gh: API rate limit exceeded (HTTP 403)");
      expect(await f.run("live")).toMatchObject({
        read: "workflow runs",
        class: "rate-limited",
      });
      expect(f.calls()).toBe(1);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a failure waiting cannot clear stays unknown", async () => {
    const f = fixture();
    try {
      f.failReads("actions/runs", 9, "gh: HTTP 401: Bad credentials");
      expect(await f.run("live")).toBe("unknown");
      expect(f.calls()).toBe(1);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("only a read that kept failing stops as not settled", () => {
    const failure = {
      read: "workflow runs",
      class: "server-fault" as const,
      reason: "HTTP 502",
    };
    expect(recoveryExit(failure)).toBe(4);
    expect(recoveryExit("unknown")).toBe(1);
    expect(recoveryExit("parked")).toBe(8);
    expect(recoveryExit("wait")).toBeNull();
    expect(recoveryExit("none")).toBeNull();
  });
});

describe("a cancelled job the runner stopped at its time limit", () => {
  test("is timed out: not re-run and not parked as cancelled CI", async () => {
    const f = fixture();
    try {
      await f.run("past-grace");
      writeFileSync(join(f.dir, "phase"), "timeout");
      expect(await f.run("fenced")).toEqual({
        timedOut: [
          {
            name: "gate",
            checkRunId: 1,
            limitMs: 30 * 60_000,
            ranMs: 30 * 60_000 + 4_000,
            run: {
              id: 1,
              createdAt: "2026-01-01T00:00:00Z",
              conclusion: "cancelled",
              jobNames: ["gate"],
            },
          },
        ],
        recovery: "none",
      });
      expect(f.reruns()).toEqual([]);
      expect(await f.run("parked")).toEqual([]);
      expect((await f.run("observe")).requestedAt).toBeNull();
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a job its concurrency group cancelled inside its limit keeps the cancelled-CI recovery", async () => {
    const f = fixture();
    try {
      await f.run("past-grace");
      writeFileSync(join(f.dir, "phase"), "concurrency");
      expect(await f.run("fenced")).toBe("wait");
      expect(f.reruns()).toEqual(["1"]);
      expect(f.stderr()).toContain(
        "check run 1 (gate) carries 1 annotation(s), none of them the runner's time-limit message",
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("annotations that are not a list are a malformed read, said in the log", async () => {
    const f = fixture();
    try {
      await f.run("past-grace");
      writeFileSync(join(f.dir, "phase"), "garbled");
      expect(await f.run("fenced")).toBe("wait");
      expect(f.reruns()).toEqual(["1"]);
      expect(f.stderr()).toContain(
        "the annotations of check run 1 (gate) did not read (malformed: the annotations answer is not a list)",
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a run of its workflow still going is waited for, not repaired", async () => {
    const f = fixture();
    try {
      await f.run("past-grace");
      writeFileSync(join(f.dir, "phase"), "rerunning");
      expect(await f.run("fenced")).toBe("wait");
      expect(f.reruns()).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("beside an ordinary cancellation, that one is re-run and the answer carries its wait", async () => {
    const f = fixture();
    try {
      await f.run("past-grace");
      writeFileSync(join(f.dir, "phase"), "mixed");
      expect(await f.run("fenced")).toMatchObject({
        timedOut: [{ name: "gate", checkRunId: 1 }],
        recovery: "wait",
      });
      expect(f.reruns()).toEqual(["3"]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("beside an ordinary cancellation whose head's re-run is spent, the park wins", async () => {
    const f = fixture();
    try {
      await f.run("spent");
      writeFileSync(join(f.dir, "phase"), "mixed");
      expect(await f.run("fenced")).toBe("parked");
      expect(f.reruns()).toEqual([]);
      expect(await f.run("parked")).toEqual(["cancelled-ci"]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("before a pass, a re-run of the other cancellation still going is waited for", async () => {
    const f = fixture();
    const job = {
      name: "gate",
      checkRunId: 1,
      limitMs: 60_000,
      ranMs: 61_000,
      run: null,
    };
    const asked = (recovery: string) =>
      f.run("before-pass", HEAD, {
        DRIVE_PR_FINAL_CI_POLL_MS: "10",
        PROBE_RECOVERY: JSON.stringify({ timedOut: [job], recovery }),
      });
    try {
      expect(await asked("wait")).toBe("continue");
      expect(await asked("none")).toBeNull();
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("is found on a later page of annotations", async () => {
    const f = fixture();
    try {
      await f.run("past-grace");
      writeFileSync(join(f.dir, "phase"), "paged");
      const answer = (await f.run("fenced")) as {
        timedOut: { name: string }[];
      };
      expect(answer.timedOut.map((job) => job.name)).toEqual(["gate"]);
      expect(f.reruns()).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("annotations that do not read leave the cancellation to the cancelled-CI recovery", async () => {
    const f = fixture();
    try {
      await f.run("past-grace");
      f.failReads("/annotations", 9, BAD_GATEWAY, { phase: "timeout" });
      expect(await f.run("fenced")).toBe("wait");
      expect(f.reruns()).toEqual(["1"]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("its answer is neither a stop nor a failed read", () => {
    const timedOut = {
      timedOut: [
        {
          name: "gate",
          checkRunId: 1,
          limitMs: 60_000,
          ranMs: 61_000,
          run: null,
        },
      ],
      recovery: "none" as const,
    };
    expect(recoveryExit(timedOut)).toBeNull();
    expect(recoveryLabel(timedOut)).toBe(
      "timed out: job `gate` ran 1m 1s and stopped at its 1-minute limit (timeout-minutes)",
    );
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
  expect(classifyDrive(input, Temporal.Now.instant()).recovery).toBe(recovery);
  expect(
    classifyDrive({ ...input, progressAgeMs: 1 }, Temporal.Now.instant())
      .recovery,
  ).toBe(recovery);
});
