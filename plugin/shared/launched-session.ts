/**
 * Whether this process runs in a session the line started: a dispatched
 * launch, or a drive's pass. The dispatcher's wrapper (`dispatch/run.ts`)
 * sets `JIG_LAUNCH` to the launch record it runs, and a driver
 * (`skills/drive-pr/scripts/lib/driver/main.ts`) hands every pass it starts
 * the launch it inherited or, for a drive nobody dispatched, its own name:
 * the pull request and the driver generation. Every process the session
 * starts inherits it.
 *
 * `jig send` reads `JIG_LAUNCH` to refuse the commands that are a person's
 * (`send/lib/verbs.ts`). That stops a skill's mistake. It does not stop a
 * session that sets out to act as its person, which can clear the variable
 * or call the forge itself with the credentials it holds
 * ([design/addresses.md](../../design/addresses.md)).
 *
 * A drive a dispatched session armed also knows that launch when it does not
 * run under it: a terminal tab's login shell does not inherit `JIG_LAUNCH`,
 * so the arm hands the tab `JIG_DISPATCHED_FROM` instead, and the driver
 * hands it on to every pass. It says only where the drive came from (Jig's
 * gate command reads it to choose the targeted form); what a pass reports as
 * its launch stays `JIG_LAUNCH`, since the pickup's launch record ends
 * before its drive does.
 */

import { LAUNCH_RECORD_ID_PATTERN } from "./records/forge-claim-shapes.ts";

/** The variable a session the line started carries. */
export const LAUNCH_VARIABLE = "JIG_LAUNCH";

/** The variable naming the dispatched launch a drive was armed from. */
export const DISPATCHED_FROM_VARIABLE = "JIG_DISPATCHED_FROM";

const dispatchLaunchId = new RegExp(LAUNCH_RECORD_ID_PATTERN);

/** The launch this process runs under, or `null` outside a session the line started. */
export function launchOf(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = (env[LAUNCH_VARIABLE] ?? "").trim();
  return value === "" ? null : value;
}

/** What a drive's passes carry: the launch the driver inherited, else the driver itself. */
export function passLaunch(
  env: Record<string, string | undefined>,
  pr: string,
  generation: number,
): string {
  return launchOf(env) ?? `drive-pr ${pr} driver ${generation}`;
}

/**
 * The dispatcher's launch record this process comes from: the one a drive
 * was armed from (`JIG_DISPATCHED_FROM`), else the one it runs under
 * (`JIG_LAUNCH`); `null` when neither names a launch record, as in a drive
 * a person armed by hand, whose passes carry the driver's own name.
 */
export function dispatchedFrom(
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const name of [DISPATCHED_FROM_VARIABLE, LAUNCH_VARIABLE]) {
    const value = (env[name] ?? "").trim();
    if (dispatchLaunchId.test(value)) return value;
  }
  return null;
}

/**
 * The launch variables a drive's passes carry: `JIG_LAUNCH` as `passLaunch`
 * names it, and the dispatched launch the drive came from, when there is one,
 * as `JIG_DISPATCHED_FROM`.
 */
export function passLaunchEnv(
  env: Record<string, string | undefined>,
  pr: string,
  generation: number,
): Record<string, string> {
  const origin = dispatchedFrom(env);
  return {
    [LAUNCH_VARIABLE]: passLaunch(env, pr, generation),
    ...(origin === null ? {} : { [DISPATCHED_FROM_VARIABLE]: origin }),
  };
}
