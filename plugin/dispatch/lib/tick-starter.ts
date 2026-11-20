/**
 * What started a tick, for its receipt (`startedBy`): `timer` (the installed
 * timer's launcher, which runs the scheduled upgrade first), `wake` (Jig's
 * wake waiter, `wake-tick.ts`), `command` (the `jig` command a person or a
 * script ran), or the name another launcher gives itself in
 * `JIG_STARTED_BY`. The launcher passes `JIG_STARTED_BY` from its own role
 * (`runtime/launcher.ts`), and the wake waiter sets it itself, so a command
 * that sets its own role on the way keeps it. A launcher copy an earlier
 * release wrote passes none: the scheduled upgrade's result it passes
 * (`JIG_SCHEDULED_UPGRADE`) still names the timer. Nothing said leaves the
 * field out.
 */
import { SCHEDULED_UPGRADE_ENV } from "../../runtime/upgrade-record.ts";

/** The variable a launcher names what started the tick in. */
const STARTED_BY_ENV = "JIG_STARTED_BY";

/** The longest name the receipt keeps. */
const NAME_LIMIT = 100;

/**
 * What started this tick, taken out of the environment so the sessions it
 * launches never carry it; read before the scheduled upgrade is taken.
 */
export function takeTickStarter(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const named = env[STARTED_BY_ENV]?.trim();
  delete env[STARTED_BY_ENV];
  if (named) return named.slice(0, NAME_LIMIT);
  return env[SCHEDULED_UPGRADE_ENV] === undefined ? undefined : "timer";
}
