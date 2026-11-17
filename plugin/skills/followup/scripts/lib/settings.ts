/**
 * The repository's `followup` section: `off`, the core arms it turns off,
 * `authority`, the acts it moves to a stricter level, and `arms`, its own
 * arms (`repo-arms.ts`). Read through the
 * shared configuration reader, from the integration branch's committed
 * file when the clone has it, so a pull request's own change to the section
 * does not decide how its preview is followed up; the working tree's
 * layers otherwise.
 */
import {
  isMapping,
  OVERLAY_RELPATH,
} from "../../../../shared/config-layers.ts";
import { layeredConfig, sourceIn } from "../../../../shared/consumer.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { ARM_IDS, type ArmId, isArmId } from "./arms.ts";
import { parseRepoArms, type RepoArm } from "./repo-arms.ts";
import {
  ACT_IDS,
  ACTS,
  type ActId,
  isActId,
  isLevel,
  type Level,
  LEVEL_WORDS,
  LEVELS,
  tightens,
} from "./authority.ts";

/** The keys the section may hold. */
const KEYS = ["off", "authority", "arms"];

export interface FollowupSettings {
  off: ArmId[];
  authority: Partial<Record<ActId, Level>>;
  /** The repository's own arms (`followup.arms`), checked. */
  arms: RepoArm[];
}

type Invalid = Outcome<never, "config-invalid">;

function invalid(
  values: Record<string, unknown>,
  field: string,
  reason: string,
): Invalid {
  return failed("config-invalid", `${reason}: ${sourceIn(values, field)}`);
}

function readOff(
  values: Record<string, unknown>,
  raw: unknown,
): Outcome<ArmId[], "config-invalid"> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw))
    return invalid(
      values,
      "followup.off",
      "followup.off must be a list of core arm ids",
    );
  const off: ArmId[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !isArmId(entry))
      return invalid(
        values,
        "followup.off",
        `followup.off names ${JSON.stringify(entry)}, which is no core arm (${ARM_IDS.join(", ")})`,
      );
    if (off.includes(entry))
      return invalid(
        values,
        "followup.off",
        `followup.off names ${entry} twice`,
      );
    off.push(entry);
  }
  return ok(off);
}

function readAuthority(
  values: Record<string, unknown>,
  raw: unknown,
): Outcome<Partial<Record<ActId, Level>>, "config-invalid"> {
  if (raw === undefined || raw === null) return ok({});
  if (!isMapping(raw))
    return invalid(
      values,
      "followup.authority",
      "followup.authority must map an act's id to a level",
    );
  const out: Partial<Record<ActId, Level>> = {};
  for (const [id, level] of Object.entries(raw)) {
    const read = readLevel(values, id, level);
    if (!read.ok) return read;
    out[read.value.id] = read.value.level;
  }
  return ok(out);
}

/** Why one `followup.authority` entry is refused; `null` when it tightens a known act. */
function levelProblem(id: string, level: unknown): string | null {
  if (!isActId(id))
    return `followup.authority names ${JSON.stringify(id)}, which is no act (${ACT_IDS.join(", ")})`;
  if (typeof level !== "string" || !isLevel(level))
    return `followup.authority.${id} must be one of ${LEVELS.join(", ")}`;
  const fixed = ACTS.find((a) => a.id === id)?.level ?? "never";
  return tightens(fixed, level)
    ? null
    : `followup.authority.${id} may only tighten the fixed table, which has it at ${fixed} (${LEVEL_WORDS[fixed]}); ${level} would loosen it`;
}

/** One `followup.authority` entry, checked. */
function readLevel(
  values: Record<string, unknown>,
  id: string,
  level: unknown,
): Outcome<{ id: ActId; level: Level }, "config-invalid"> {
  const problem = levelProblem(id, level);
  // `levelProblem` found none, so the id is an act and the level a level.
  return problem === null
    ? ok({ id: id as ActId, level: level as Level })
    : invalid(values, "followup.authority", problem);
}

/** The `followup` section of merged configuration `values`, checked. */
export function parseFollowupSettings(
  values: Record<string, unknown>,
): Outcome<FollowupSettings, "config-invalid"> {
  const section = values.followup;
  if (section === undefined || section === null)
    return ok({ off: [], authority: {}, arms: [] });
  if (!isMapping(section))
    return invalid(values, "followup", "followup must be a mapping");
  for (const key of Object.keys(section))
    if (!KEYS.includes(key))
      return invalid(
        values,
        `followup.${key}`,
        `followup.${key} is not a field of the follow-up (${KEYS.join(", ")})`,
      );
  const off = readOff(values, section.off);
  if (!off.ok) return off;
  const authority = readAuthority(values, section.authority);
  if (!authority.ok) return authority;
  const arms = parseRepoArms(values, section.arms);
  if (!arms.ok) return arms;
  return ok({ off: off.value, authority: authority.value, arms: arms.value });
}

/** How to read a file at a revision: its text, `null` when the revision has no such file, `undefined` when the revision cannot be read. */
export type ShowFile = (
  ref: string,
  path: string,
) => Promise<string | null | undefined>;

/** Where the configuration a run used came from. */
export type ConfigOrigin = "integration branch" | "working tree";

/** The variables that would set the repository's own arms: never read beside the integration branch's file. */
const REPOSITORY_ARM_ENV = /^JIG__FOLLOWUP(?:__ARMS.*)?$/i;

/** `env` without the variables that declare the repository's arms. */
function withoutArmVariables(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !REPOSITORY_ARM_ENV.test(name)),
  );
}

/**
 * The repository's merged configuration: its layers with the repository's
 * file as `ref` holds it, when `ref` is given, no `JIG_OVERLAY` names
 * another file, and the clone can read it; the working tree's layers
 * otherwise.
 */
export async function runConfig(
  root: string,
  ref: string | null,
  show: ShowFile,
  env: Record<string, string | undefined> = process.env,
): Promise<
  Outcome<
    { values: Record<string, unknown>; origin: ConfigOrigin },
    "config-invalid"
  >
> {
  try {
    if (ref !== null && !env.JIG_OVERLAY) {
      const text = await show(ref, OVERLAY_RELPATH);
      if (text !== undefined)
        return ok({
          // The command-bearing declarations come from the reviewed file:
          // no environment variable replaces them.
          values: layeredConfig(root, withoutArmVariables(env), text).values,
          origin: "integration branch",
        });
    }
    return ok({
      values: layeredConfig(root, env).values,
      origin: "working tree",
    });
  } catch (error) {
    return failed(
      "config-invalid",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}
