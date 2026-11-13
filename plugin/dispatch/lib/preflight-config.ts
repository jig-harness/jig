/**
 * The machine file's `preflight` key: the checks the tick runs on each
 * account it may launch on, before it launches a stage that needs them
 * (`preflight.ts`). A credential belongs to an account on a machine, so the
 * key is the host's, never a repository's.
 *
 * ```yaml
 * preflight: [tracker]   # the default; [] turns the checks off
 * ```
 *
 * `tracker` reads the repository's tracker headless under the account's
 * environment, the read a pass of a tracker stage would make first.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

/** The checks a machine file can name. */
const PREFLIGHT_PROBES = ["tracker"] as const;
export type PreflightProbe = (typeof PREFLIGHT_PROBES)[number];

/** The checks a machine file that names none runs. */
const DEFAULT_PREFLIGHT: readonly PreflightProbe[] = ["tracker"];

/** `preflight`'s value: a list of distinct known checks, the default when absent. */
export function preflightSetting(
  value: unknown,
): Outcome<PreflightProbe[], "invalid"> {
  if (value === undefined || value === null) return ok([...DEFAULT_PREFLIGHT]);
  const known = PREFLIGHT_PROBES as readonly unknown[];
  if (
    !Array.isArray(value) ||
    value.some((probe) => !known.includes(probe)) ||
    new Set(value).size !== value.length
  )
    return failed(
      "invalid",
      `preflight must list distinct checks from ${PREFLIGHT_PROBES.join(", ")}, or be [] to run none`,
    );
  return ok(value as PreflightProbe[]);
}

/** The checks a machine configuration runs; one built without the key runs the default. */
export function preflightOf(machine: {
  preflight?: readonly PreflightProbe[];
}): readonly PreflightProbe[] {
  return machine.preflight ?? DEFAULT_PREFLIGHT;
}
