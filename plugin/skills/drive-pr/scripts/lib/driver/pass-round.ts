/**
 * What the driver hands each pass about its round, and records as a pass
 * starts. Every pass, review or repair, reads its round in `DRIVE_PR_ROUND`
 * and stamps its round report with it (`round-report.ts`); the driver
 * remembers the round of the last pass it started, the only round whose
 * report its closing report reads (`closing-report.ts`). Under the
 * dispatcher's wrapper (`shared/driver-report.ts`), a pass the driver gave a
 * session id has that id recorded on the launch record, round by round
 * (`dispatch/lib/round-sessions.ts`); a drive armed any other way records
 * nothing there.
 */
import { recordRoundSession } from "../../../../../dispatch/lib/round-sessions.ts";
import { driverReportPath } from "../../../../../shared/driver-report.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { launchOf } from "../../../../../shared/launched-session.ts";
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

/**
 * A pass of round `round` started: remember its round and, under the
 * dispatcher's wrapper, record its session id on the launch record. Best
 * effort: a session that cannot be recorded is one line on the driver's
 * output, never a reason to stop the pass.
 */
export function notePassStarted(
  pr: string,
  round: number,
  session: string | null,
  env: Record<string, string | undefined> = process.env,
): void {
  driverRuntime.passRound = round;
  const launch = launchOf(env);
  if (session === null || launch === null || driverReportPath(env) === null)
    return;
  try {
    if (!recordRoundSession(launch, Number(pr), round, session))
      console.error(
        `drive.ts: round ${round}'s pass session was not recorded on launch record ${launch}: it is not this drive's record`,
      );
  } catch (error) {
    console.error(
      `drive.ts: round ${round}'s pass session was not recorded on launch record ${launch} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
