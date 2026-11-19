import { expect, test } from "bun:test";
import { join } from "node:path";
import { readDriverReport } from "../../../shared/driver-report.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { PASS_LOUD, spawnDriveIn, state } from "./drive-loop-harness.ts";
import {
  type Fixture,
  DORMANT_ARM,
  REVIEWER_RUN,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { lastStopEvent } from "../scripts/lib/state/events.ts";
import { narrativeOf } from "../scripts/lib/state/handoff.ts";
import {
  ledgerFromState,
  parseLedger,
  renderLedger,
} from "../scripts/lib/state/ledger.ts";
import type { DriveState } from "../scripts/lib/state/schema.ts";
import { readProbeStop } from "../scripts/lib/status/probe-stop.ts";

const launch = "probe-stop-test";

useDrivePrSuite();

const cases: {
  code: number;
  probeState: string;
  reason: string;
  fixture: Partial<Fixture>;
  env?: Record<string, string>;
}[] = [
  {
    code: 1,
    probeState: "INDETERMINATE",
    reason: "cannot read check-runs",
    fixture: { checkRunsUnreadable: true },
  },
  {
    code: 4,
    probeState: "AWAITING_REVIEWER",
    reason: "gave up after 5s",
    fixture: { reviewedSha: null, checkRuns: [REVIEWER_RUN] },
  },
  {
    code: 9,
    probeState: "PR_CONFLICTING",
    reason: "conflicts with its base",
    fixture: {
      threads: [],
      checkRuns: [DORMANT_ARM],
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    },
    env: { DRIVE_PR_CONFLICT_REPAIR_ROUNDS: "0" },
  },
];

for (const { code, probeState, reason, fixture, env } of cases) {
  test(`a status probe exit ${code} records its state and reason across the stop`, async () => {
    const { dir, stateDir } = writeFixture(
      { threads: [], head: scratchClean.head, ...fixture },
      scratchClean.dir,
    );
    const reportFile = join(dir, "driver-report.json");
    const run = spawnDriveIn(
      dir,
      stateDir,
      [
        "--no-head-sync",
        "--timeout",
        "5",
        "--interval",
        "5",
        "--",
        ...PASS_LOUD,
      ],
      undefined,
      {
        env: {
          JIG_DRIVER_REPORT: reportFile,
          JIG_LAUNCH: launch,
          ...env,
        },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, code);
    expect(stderr).not.toContain("RAN_THE_PASS");
    const stored = await state(stateDir, ["get", "999"]);
    expectSpawnExit(stored, 0);
    const saved = JSON.parse(stored.stdout) as DriveState;
    const stop = lastStopEvent(saved.events ?? []);
    const narrative = narrativeOf(join(dir, "handoff", "pr-drive-999.md"));
    const probe = readProbeStop(stderr);
    if (probe === null)
      throw Error(`the driver did not print a probe stop: ${stderr}`);
    expect(probe.code).toBe(code);
    expect(probe.state).toBe(probeState);
    expect(probe.reason).toContain(reason);
    expect(probe.failure).toBe(code === 1 ? "read" : undefined);
    expect(narrative.join("\n")).toContain(probeState);
    expect(narrative.join("\n")).toContain(reason);
    expect(stop?.cause).toBe(String(code));
    expect(stop?.probe).toEqual(probe);

    if (stop === undefined) throw Error("the driver did not record a stop");
    const mirror = renderLedger(
      ledgerFromState(saved, {
        generation: 1,
        driver: {
          actor: "fixture",
          clone: "fixture",
          heartbeat: stop.at,
          state: "stopped",
          exit: code,
        },
        narrative,
        claims: [],
      }),
    );
    if ("error" in mirror) throw Error(mirror.error);
    const ledger = parseLedger(mirror.body);
    expect(ledger).toMatchObject({
      kind: "ledger",
      ledger: { driver: { probe }, events: [stop] },
    });

    const report = readDriverReport(reportFile, launch);
    expect(report).toMatchObject({
      ok: true,
      value: {
        concluded: expect.stringContaining(reason),
        ...(code === 1 ? { cause: "environment" } : {}),
      },
    });
  }, 30_000);
}
