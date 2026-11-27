/**
 * The variables an installed job runs with beyond the ones Jig writes into
 * it. A scheduled job reads no shell profile, so a credential its runs need
 * (a tracker's, a notification channel's address) has to be in the job
 * itself. Two ways put one there:
 *
 * - **Kept from the installed job.** A variable a person added to an
 *   installed launchd job's `EnvironmentVariables` is carried into the job
 *   an install writes in its place, so a reinstall does not drop it. Jig's
 *   own variables (`managed`) are written fresh, never carried.
 * - **Captured by name.** `--env NAME` reads the variable's value from the
 *   installing shell. It takes a name only, never `NAME=VALUE`, so a value
 *   never reaches shell history or the process list.
 *
 * Either way a value is never shown: a preview names the variables only.
 */
import { failed, ok, type Outcome } from "../shared/outcome.ts";
import { launchdEnvironment } from "./installed-job.ts";

/** What a preview shows in place of a value it must not print. */
export const HIDDEN_VALUE = "(hidden)";

/** A variable's name as a shell exports it. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables the installed launchd job (`plist`, null when there is
 * none) holds that are not `managed`: what a reinstall keeps.
 */
export function carriedEnvironment(
  plist: string | null,
  managed: ReadonlySet<string>,
): Record<string, string> {
  if (plist === null) return {};
  return Object.fromEntries(
    Object.entries(launchdEnvironment(plist)).filter(
      ([name]) => !managed.has(name),
    ),
  );
}

/**
 * The values of the variables `names` in `env`, the installing shell's, or
 * why they cannot be captured: a `NAME=VALUE` form, a word that is not a
 * name, a variable Jig writes itself (`managed`), or one unset, empty or
 * holding a line break. No refusal repeats a value.
 */
export function capturedEnvironment(
  names: readonly string[],
  env: Record<string, string | undefined>,
  managed: ReadonlySet<string>,
): Outcome<Record<string, string>, "usage"> {
  const captured: Record<string, string> = {};
  for (const name of names) {
    const refusal = captureRefusal(name, env[name], managed);
    if (refusal !== null) return failed("usage", refusal);
    captured[name] = env[name] as string;
  }
  return ok(captured);
}

function captureRefusal(
  name: string,
  value: string | undefined,
  managed: ReadonlySet<string>,
): string | null {
  const equals = name.indexOf("=");
  if (equals >= 0) {
    const before = name.slice(0, equals);
    const named = NAME.test(before) ? before : "NAME";
    return `--env takes a variable's name, never NAME=VALUE: a value on the command line lands in shell history and the process list. Export ${named} in this shell, then pass --env ${named}`;
  }
  if (!NAME.test(name))
    return "--env takes a variable's name: letters, digits and underscores, not starting with a digit";
  if (managed.has(name))
    return `--env ${name}: Jig writes ${name} into the job itself`;
  if (value === undefined || value === "")
    return `--env ${name}: ${name} is unset or empty in this shell; export it first`;
  if (/[\r\n\0]/.test(value))
    return `--env ${name}: its value holds a line break or NUL, which a scheduled job cannot carry`;
  return null;
}

/** `env` with the value of each name in `hidden` replaced by `HIDDEN_VALUE`. */
export function maskedEnvironment(
  env: Record<string, string>,
  hidden: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      hidden.has(name) ? HIDDEN_VALUE : value,
    ]),
  );
}
