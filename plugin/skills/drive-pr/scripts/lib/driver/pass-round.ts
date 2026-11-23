/**
 * What the driver hands each pass about its round, and records as a pass
 * starts. Every pass, review or repair, reads its round in `DRIVE_PR_ROUND`
 * and stamps its round report with it (`round-report.ts`); the driver
 * remembers the round and start time of the last pass it started, the only
 * round report its closing report reads, and only when the pass wrote it (`closing-report.ts`). Under the
 * dispatcher's wrapper (`shared/driver-report.ts`), the driver records each
 * known session id on the launch record, round by round.
 */
import { recordRoundSession } from "../../../../../dispatch/lib/round-sessions.ts";
import {
  type AgentHarness,
  harnessOfProgram,
} from "../../../../../shared/agent-harness/index.ts";
import { driverReportPath } from "../../../../../shared/driver-report.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { launchOf } from "../../../../../shared/launched-session.ts";
import { currentIso } from "../../../../../shared/time.ts";
import { runObservedPass } from "../driver-observation.ts";
import type { RunOptions, RunResult } from "../proc.ts";
import { readDriveState } from "./rearm.ts";
import { driverRuntime } from "./runtime.ts";

/** The variable a pass reads its round from. */
export const ROUND_VARIABLE = "DRIVE_PR_ROUND";

/** `env` for a pass of round `round`. */
export function withPassRound(
  env: NodeJS.ProcessEnv,
  round: number,
): NodeJS.ProcessEnv {
  env[ROUND_VARIABLE] = String(round);
  return env;
}

/**
 * The round a repair pass runs in: the round of the last pass this driver
 * started, else the drive's durable round count, else `0`.
 */
export async function repairRound(pr: string): Promise<number> {
  if (driverRuntime.passRound !== null) return driverRuntime.passRound;
  const state = await readDriveState(pr).catch((error: unknown) => {
    swallow(error, "the drive state could not be read for a repair's round");
    return null;
  });
  return state?.rounds ?? 0;
}

/** A failed launch-record write is logged without interrupting the pass. */
function recordSession(
  launch: string,
  pr: string,
  round: number,
  session: string,
  startedAt: string,
): void {
  try {
    const refused = recordRoundSession(
      launch,
      Number(pr),
      round,
      session,
      undefined,
      startedAt,
    );
    if (refused !== null)
      console.error(
        `drive.ts: round ${round}'s pass session was not recorded on launch record ${launch}: ${refused}`,
      );
  } catch (error) {
    swallow(error, "a pass session could not be saved on its launch record");
    console.error(
      `drive.ts: round ${round}'s pass session was not recorded on launch record ${launch} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** A harness that prints its session id (Codex) writes it in its startup header. Inspect a bounded prefix of each stream. */
const STARTUP_BYTES = 16 * 1024;

function printedSession(harness: AgentHarness, keep: (id: string) => void) {
  const prefix = { stdout: "", stderr: "" };
  const remaining = { stdout: STARTUP_BYTES, stderr: STARTUP_BYTES };
  let found = false;
  const inspect = (text: string) => {
    if (found) return;
    const session = harness.sessionIdIn(text);
    if (session === null) return;
    found = true;
    keep(session);
  };
  return {
    observe(stream: "stdout" | "stderr", bytes: Buffer) {
      if (found || remaining[stream] === 0) return;
      const chunk = bytes.subarray(0, remaining[stream]);
      remaining[stream] -= chunk.length;
      const text = prefix[stream] + chunk.toString("utf8");
      const lineEnd = text.lastIndexOf("\n") + 1;
      prefix[stream] = text.slice(lineEnd);
      inspect(text.slice(0, lineEnd));
    },
    finish() {
      // An unterminated line can only be accepted after the output ends.
      for (const stream of ["stdout", "stderr"] as const) {
        if (remaining[stream] > 0) inspect(prefix[stream]);
      }
    },
  };
}

/** Stamp a pass's round at spawn and record its id as soon as it is known. */
export async function runRoundPass(
  argv: string[],
  { pr, round, session }: { pr: string; round: number; session: string | null },
  options: RunOptions,
): Promise<RunResult> {
  const launch = driverReportPath() === null ? null : launchOf(process.env);
  let startedAt: string | null = null;
  const keep = (id: string) => {
    if (launch !== null && startedAt !== null)
      recordSession(launch, pr, round, id, startedAt);
  };
  const harness = harnessOfProgram(argv[0]);
  const startup =
    launch !== null && harness?.capabilities.sessionId === "printed"
      ? printedSession(harness, keep)
      : null;
  const result = await runObservedPass(argv, {
    ...options,
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
    ...(startup === null ? {} : { onInheritedOutput: startup.observe }),
    onSpawn: (handle) => {
      startedAt = currentIso();
      driverRuntime.activePass = handle;
      driverRuntime.passRound = round;
      driverRuntime.passStartedAt = startedAt;
      if (session !== null) keep(session);
      options.onSpawn?.(handle);
    },
  });
  startup?.finish();
  return result;
}
