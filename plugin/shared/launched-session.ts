/**
 * Whether this process runs in a session the line started: a dispatched
 * launch, or a drive's pass. The dispatcher's wrapper (`dispatch/run.ts`)
 * sets `JIG_LAUNCH` to the launch record it runs, and a driver
 * (`skills/drive-pr/scripts/lib/driver/main.ts`) hands every pass it starts
 * the launch it inherited or, for a drive nobody dispatched, its own name:
 * the pull request and the driver generation. Every process the session
 * starts inherits it.
 *
 * `jig send` reads it to refuse the commands that are a person's
 * (`send/lib/verbs.ts`). That stops a skill's mistake. It does not stop a
 * session that sets out to act as its person, which can clear the variable
 * or call the forge itself with the credentials it holds
 * ([design/addresses.md](../../design/addresses.md)).
 */

/** The variable a session the line started carries. */
export const LAUNCH_VARIABLE = "JIG_LAUNCH";

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
