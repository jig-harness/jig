/**
 * `tracker.ts claim`'s options, read from its command line:
 *
 * - `--for <person>`, `--ancestor <epic>` and `--blocking <item>`: a served
 *   claim, made on a person's behalf (`served-claim.ts`);
 * - `--factory-ancestor <epic>`: a factory-inherited claim;
 * - `--override-blockers "<reason>"`: a person's decision to start the item
 *   ahead of its open blockers (`blocker-override.ts`), with the reason it is
 *   recorded under;
 * - `--work-batch`: the claim of a work-batch member, which never takes an
 *   override.
 *
 * The override is a person's, made in an interactive session: it is refused
 * (a usage error, exit 2, nothing read or written) in a session the line
 * started (`JIG_LAUNCH` set), with a served or factory claim's options, and
 * in a work-batch claim.
 */
import { launchOf } from "../../../../shared/launched-session.ts";
import { UsageError } from "./cli.ts";

/** The options a claim takes a value for, written `--flag value` or `--flag=value`. */
const VALUED = [
  "--for",
  "--ancestor",
  "--blocking",
  "--factory-ancestor",
  "--override-blockers",
] as const;

/** Each valued option with its value, as the generic flag check admits it. */
export const CLAIM_VALUED_OPTION = new RegExp(
  `^(?:${VALUED.join("|")})=.+`,
  "s",
);

/** The flag a work-batch member's claim carries. */
export const WORK_BATCH_FLAG = "--work-batch";

export interface ClaimOptions {
  person?: string | undefined;
  ancestor?: string | undefined;
  blocking?: string | undefined;
  factoryAncestor?: string | undefined;
  /** The person's reason for starting ahead of open blockers. */
  overrideBlockers?: string | undefined;
}

const needs = (flag: string) =>
  flag === "--override-blockers"
    ? "--override-blockers requires a reason"
    : `${flag} requires an identity or issue key`;

/** Join each valued option to its value before generic positional and flag validation. */
export function normalizeClaimOptions(rest: string[]): void {
  for (const flag of VALUED) {
    const index = rest.indexOf(flag);
    if (index === -1) continue;
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new UsageError(needs(flag));
    rest.splice(index, 2, `${flag}=${value}`);
  }
  for (const flag of VALUED)
    if (rest.filter((v) => v.startsWith(`${flag}=`)).length > 1)
      throw new UsageError("duplicate claim option");
}

const SERVED_MISUSE =
  "claim accepts one nonempty --for=PERSON, --ancestor=ISSUE and --blocking=ISSUE";

/** What each valued option's misuse is reported as. */
const MISUSE: Record<(typeof VALUED)[number], string> = {
  "--for": SERVED_MISUSE,
  "--ancestor": SERVED_MISUSE,
  "--blocking": SERVED_MISUSE,
  "--factory-ancestor": "claim accepts one nonempty --factory-ancestor=ISSUE",
  "--override-blockers": needs("--override-blockers"),
};

/** The one value of `flag`, `undefined` when absent; a usage error for an empty or repeated one. */
function optionValue(
  flags: Set<string>,
  flag: (typeof VALUED)[number],
): string | undefined {
  const given = [...flags].filter(
    (f) => f === flag || f.startsWith(`${flag}=`),
  );
  if (given.length === 0) return undefined;
  const value = (given[0] as string).slice(flag.length + 1);
  if (given.length > 1 || value === "") throw new UsageError(MISUSE[flag]);
  return value;
}

/** Why `--override-blockers` cannot be taken here; `null` when it can. */
export function overrideRefusal(
  options: ClaimOptions,
  workBatch: boolean,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (options.overrideBlockers === undefined) return null;
  if (options.overrideBlockers.trim() === "")
    return "--override-blockers requires a reason";
  if (launchOf(env) !== null)
    return "--override-blockers is a person's decision in an interactive session; a session the line started (JIG_LAUNCH is set) cannot take it";
  if (options.person !== undefined || options.factoryAncestor !== undefined)
    return "--override-blockers cannot be combined with a served or factory claim's options";
  if (workBatch)
    return "--override-blockers cannot be taken by a work-batch member's claim";
  return null;
}

/** The claim's options from its flags; a usage error for a combination it cannot take. */
export function claimOptions(
  flags: Set<string>,
  env: Record<string, string | undefined> = process.env,
): ClaimOptions {
  const read = (flag: (typeof VALUED)[number]) => optionValue(flags, flag);
  const options: ClaimOptions = {
    person: read("--for"),
    ancestor: read("--ancestor"),
    blocking: read("--blocking"),
    factoryAncestor: read("--factory-ancestor"),
    overrideBlockers: read("--override-blockers"),
  };
  const served =
    options.person !== undefined ||
    options.ancestor !== undefined ||
    options.blocking !== undefined;
  if (options.factoryAncestor !== undefined && served)
    throw new UsageError(
      "--factory-ancestor cannot be combined with served claim options",
    );
  if (
    (options.ancestor !== undefined || options.blocking !== undefined) &&
    options.person === undefined
  )
    throw new UsageError("--ancestor and --blocking require --for");
  const refused = overrideRefusal(options, flags.has(WORK_BATCH_FLAG), env);
  if (refused !== null) throw new UsageError(refused);
  return options;
}
