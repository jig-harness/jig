/**
 * The repository's own follow-up arms (`followup.arms[]` in
 * `.config/jig.yaml`): obligations one repository has after a merge and no
 * other does, settled under the same record-and-settle rules as the core
 * arms. Each arm names when it applies (`when`, change areas; absent: every
 * merge) and what settles it, in one of three forms:
 *
 * - `instructions`: a path to an instructions (prompt) file the agent
 *   carries out, read from the integration branch, never the pull request's
 *   tree, so a pull request cannot rewrite the arm that follows it up;
 * - `check_command`: a read-only command a repository supplies
 *   (`shared/repo-command.ts`): the facts JSON on standard input, a verdict
 *   JSON on standard output, run from the repository root without the
 *   tracker and forge tokens, bounded in time and output. A run past its
 *   limit, a nonzero exit or output that does not read as a verdict is
 *   `unread`, never `not-owed`;
 * - `skill`: the slash command of a skill from any source, which the agent
 *   runs and then records the arm's verdict.
 *
 * An arm may pair an instructions file with a check command: the check
 * reads the verdict, the instructions say what to carry out. A skill stands
 * alone. Configuration never widens the fixed authority table: what an arm
 * carries out is an act of that table like any other.
 */
import { posix } from "node:path";
import { isMapping } from "../../../../shared/config-layers.ts";
import { sourceIn } from "../../../../shared/consumer.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { readTimeoutEnv } from "../../../../shared/proc.ts";
import {
  oneLine,
  type RepoCommand,
  type RepoCommandResult,
} from "../../../../shared/repo-command.ts";
import { FOLLOWUP_VERDICT_SHAPE } from "../../../../shared/repo-command-shapes.ts";
import { matches } from "../../../../shared/shapes.ts";
import {
  DEFAULT_FOLLOWUP_CHECK_TIMEOUT_SEC,
  FOLLOWUP_CHECK_TIMEOUT_ENV,
} from "../../../../shared/repo-commands.ts";
import { ARM_IDS, type ArmPlan, isArmId } from "./arms.ts";
import type { ChangeAreas, Facts } from "./facts.ts";
import { type RecordFailure, recordVerdict, type RunFile } from "./run.ts";

/** The forms an arm's work may take, as the configuration names them. */
export const REPO_ARM_FORMS = [
  "instructions",
  "check_command",
  "skill",
] as const;

/** Every key an arm may hold. */
const ARM_KEYS: readonly string[] = ["id", "title", "when", ...REPO_ARM_FORMS];

/** An arm's id: lowercase words joined by hyphens, like the core arms'. */
export const REPO_ARM_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A skill's slash command: a slash, the skill's name (with its plugin's), and any arguments. */
export const REPO_ARM_SKILL_PATTERN =
  /^\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:\s+\S.*)?$/;

const FIELD = "followup.arms";

/** One repository arm, checked. */
export interface RepoArm {
  id: string;
  /** What the report calls it; the id when the configuration names no title. */
  title: string;
  /** The change areas it applies to; null for every merge. */
  when: string[] | null;
  /** The instructions file's path from the repository root. */
  instructions: string | null;
  checkCommand: string | null;
  skill: string | null;
}

type Invalid = Outcome<never, "config-invalid">;

function invalid(values: Record<string, unknown>, reason: string): Invalid {
  return failed("config-invalid", `${reason}: ${sourceIn(values, FIELD)}`);
}

/** A nonempty string, or why the field is refused. */
function text(raw: unknown, label: string): Outcome<string | null, "invalid"> {
  if (raw === undefined || raw === null) return ok(null);
  return typeof raw === "string" && raw.trim() !== ""
    ? ok(raw.trim())
    : failed("invalid", `${label} must be nonempty text`);
}

/** The instructions path, relative and inside the repository, or why it is refused. */
function instructionsPath(
  raw: unknown,
  label: string,
): Outcome<string | null, "invalid"> {
  const read = text(raw, label);
  if (!read.ok || read.value === null) return read;
  const path = posix.normalize(read.value.replace(/\\/g, "/"));
  return path.startsWith("/") || path === ".." || path.startsWith("../")
    ? failed(
        "invalid",
        `${label} must be a path inside the repository, from its root`,
      )
    : ok(path.replace(/^\.\//, ""));
}

function whenOf(
  raw: unknown,
  label: string,
): Outcome<string[] | null, "invalid"> {
  if (raw === undefined || raw === null) return ok(null);
  const valid =
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((a) => typeof a === "string" && a.trim() !== "");
  return valid
    ? ok(raw.map((a: string) => a.trim()))
    : failed(
        "invalid",
        `${label} must be a nonempty list of change areas (leave it out for every merge)`,
      );
}

/** Why `entry`'s keys are refused: one no arm holds, which is no form an arm can take. */
function unknownKey(
  entry: Record<string, unknown>,
  label: string,
): string | null {
  const key = Object.keys(entry).find((k) => !ARM_KEYS.includes(k));
  return key === undefined
    ? null
    : `${label} has ${key}, which is no field of an arm (${ARM_KEYS.join(", ")}): an arm runs an instructions file, a check command or a skill`;
}

/** Why the arm's forms do not combine; null when they do. */
function formsProblem(arm: RepoArm, label: string): string | null {
  const forms = [arm.instructions, arm.checkCommand, arm.skill].filter(
    (f) => f !== null,
  );
  if (forms.length === 0)
    return `${label} names nothing to run: give it instructions, a check_command or a skill`;
  if (arm.skill !== null && forms.length > 1)
    return `${label}: a skill arm stands alone; only instructions and a check_command combine`;
  if (arm.skill !== null && !REPO_ARM_SKILL_PATTERN.test(arm.skill))
    return `${label}.skill must be a skill's slash command, such as /team:verify`;
  return null;
}

/** One entry of `followup.arms`, checked; the ids already taken refuse a repeat. */
function readArm(
  entry: unknown,
  index: number,
  taken: ReadonlySet<string>,
): Outcome<RepoArm, "invalid"> {
  const at = `${FIELD}[${index}]`;
  if (!isMapping(entry)) return failed("invalid", `${at} must be a mapping`);
  const problem = unknownKey(entry, at) ?? idProblem(entry.id, at, taken);
  if (problem !== null) return failed("invalid", problem);
  const label = `${at} (${String(entry.id)})`;
  const arm = armOf(entry, String(entry.id), label);
  if (!arm.ok) return arm;
  const forms = formsProblem(arm.value, label);
  return forms === null ? arm : failed("invalid", forms);
}

/** Why `id` cannot name an arm at `at`; null when it can. */
function idProblem(
  id: unknown,
  at: string,
  taken: ReadonlySet<string>,
): string | null {
  if (typeof id !== "string" || !REPO_ARM_ID_PATTERN.test(id))
    return `${at}.id must be lowercase words joined by hyphens, such as website`;
  if (isArmId(id))
    return `${at} (${id}) collides with the core arm ${id}: give it an id of its own (core arms: ${ARM_IDS.join(", ")})`;
  return taken.has(id) ? `${FIELD} names ${id} twice` : null;
}

/** The arm `entry` declares under `id`, each field checked; `label` names it in a refusal. */
function armOf(
  entry: Record<string, unknown>,
  id: string,
  label: string,
): Outcome<RepoArm, "invalid"> {
  const title = text(entry.title, `${label}.title`);
  if (!title.ok) return title;
  const when = whenOf(entry.when, `${label}.when`);
  if (!when.ok) return when;
  const instructions = instructionsPath(
    entry.instructions,
    `${label}.instructions`,
  );
  if (!instructions.ok) return instructions;
  const checkCommand = text(entry.check_command, `${label}.check_command`);
  if (!checkCommand.ok) return checkCommand;
  const skill = text(entry.skill, `${label}.skill`);
  if (!skill.ok) return skill;
  return ok({
    id,
    title: title.value ?? id,
    when: when.value,
    instructions: instructions.value,
    checkCommand: checkCommand.value,
    skill: skill.value,
  });
}

/** `followup.arms` of merged configuration `values`, checked. */
export function parseRepoArms(
  values: Record<string, unknown>,
  raw: unknown,
): Outcome<RepoArm[], "config-invalid"> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw))
    return invalid(values, `${FIELD} must be a list of arms`);
  const arms: RepoArm[] = [];
  const taken = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const read = readArm(entry, index, taken);
    if (!read.ok) return invalid(values, read.failure.reason);
    arms.push(read.value);
    taken.add(read.value.id);
  }
  return ok(arms);
}

/** How to read a file at a revision: its text, `null` when the revision has no such file, `undefined` when it cannot be read. */
type ShowFile = (
  ref: string,
  path: string,
) => Promise<string | null | undefined>;

/**
 * Refused when an arm names an instructions file `ref` does not hold. A
 * revision that cannot be read refuses nothing here: reading the file is
 * what fails, and the arm is recorded `unread` then.
 */
export async function checkInstructionFiles(
  values: Record<string, unknown>,
  arms: readonly RepoArm[],
  ref: string,
  show: ShowFile,
): Promise<Outcome<null, "config-invalid">> {
  for (const arm of arms) {
    if (arm.instructions === null) continue;
    if ((await show(ref, arm.instructions)) === null)
      return invalid(
        values,
        `${FIELD} (${arm.id}) names the instructions file ${arm.instructions}, which ${ref} does not have: commit it to the integration branch first`,
      );
  }
  return ok(null);
}

/** The repository arms a run settles, in order, and the ones it skips with why. */
export interface RepoArmPlan {
  apply: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/** Why `arm` does not apply to a run of `mode` over `areas`; null when it does. */
function skipReason(
  arm: RepoArm,
  mode: Facts["mode"],
  areas: ChangeAreas,
): string | null {
  if (arm.skill !== null && mode === "preview")
    return "a skill arm runs only after the merge: a preview carries out nothing";
  // Change areas that could not be read never skip an arm on a guess.
  if (arm.when === null || !areas.known) return null;
  const touched = new Set([...areas.seedAreas, ...areas.areas]);
  return arm.when.some((a) => touched.has(a))
    ? null
    : `the merge touches none of its change areas (${arm.when.join(", ")})`;
}

/** Which repository arms apply to a run of `mode` whose change touches `areas`. */
export function planRepoArms(
  arms: readonly RepoArm[],
  mode: Facts["mode"],
  areas: ChangeAreas,
): RepoArmPlan {
  const plan: RepoArmPlan = { apply: [], skipped: [] };
  for (const arm of arms) {
    const reason = skipReason(arm, mode, areas);
    if (reason === null) plan.apply.push(arm.id);
    else plan.skipped.push({ id: arm.id, reason });
  }
  return plan;
}

/** The core arm the repository arms run before: the next step weighs what they found owed. */
const BEFORE = "next-step";

/**
 * The run's whole plan: the core arms with the repository arms that apply
 * placed before the next step (after the last core arm when the next step
 * is off), and every repository arm's declaration, for the ledger.
 */
export function withRepoArms(
  core: ArmPlan,
  arms: readonly RepoArm[],
  mode: Facts["mode"],
  areas: ChangeAreas,
): ArmPlan {
  const repo = planRepoArms(arms, mode, areas);
  const at = core.apply.indexOf(BEFORE);
  const cut = at < 0 ? core.apply.length : at;
  return {
    apply: [
      ...core.apply.slice(0, cut),
      ...repo.apply,
      ...core.apply.slice(cut),
    ],
    skipped: [...core.skipped, ...repo.skipped],
    repository: [...arms],
  };
}

/** What one arm runs, for a person reading the list of arms. */
export function describeArm(arm: RepoArm): string {
  const parts = [
    arm.checkCommand === null ? null : `check command \`${arm.checkCommand}\``,
    arm.instructions === null ? null : `instructions ${arm.instructions}`,
    arm.skill === null ? null : `skill ${arm.skill}`,
  ].filter((p) => p !== null);
  const when = arm.when === null ? "" : ` (when ${arm.when.join(", ")})`;
  return `repository arm: ${parts.join(", then ")}${when}`;
}

/** A check command's answer, as the ledger records it. */
export interface CheckAnswer {
  verdict: "owed" | "not-owed" | "pending" | "unread";
  evidence: string;
  items: string[];
}

function unread(reason: string): CheckAnswer {
  return { verdict: "unread", evidence: reason, items: [] };
}

/** The verdict a check command printed, or `unread` with why its output does not read as one. */
export function readCheckOutput(name: string, stdout: string): CheckAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unread(
      `${name} printed no verdict JSON: ${oneLine(stdout, 120) || "nothing"}`,
    );
  }
  if (!matches(FOLLOWUP_VERDICT_SHAPE, parsed))
    return unread(
      `${name} printed JSON that is no verdict ({"verdict": "owed"|"not-owed"|"pending"|"unread", "items": [...], "evidence": "..."})`,
    );
  return {
    verdict: parsed.verdict,
    evidence: parsed.evidence.trim(),
    items: (parsed.items ?? []).map((i) => i.trim()).filter((i) => i !== ""),
  };
}

/**
 * `run` with arm `id`'s check answer recorded through the same ledger as
 * every verdict. An answer whose evidence is empty or checks nothing ("nothing
 * found") is recorded `unread`: a verdict nobody can check settles nothing.
 */
export function recordCheck(
  run: RunFile,
  id: string,
  answer: CheckAnswer,
): Outcome<RunFile, RecordFailure> {
  const { verdict, evidence, items } = answer;
  const recorded = recordVerdict(run, id, verdict, evidence, items, "check");
  if (recorded.ok || recorded.failure.code !== "empty-evidence")
    return recorded;
  return recordVerdict(
    run,
    id,
    "unread",
    `its check command answered ${verdict} with no checkable evidence (${JSON.stringify(oneLine(evidence, 80))})`,
    [],
    "check",
  );
}

/** Runs a repository's command: `runRepoCommand`, or a stand-in in a test. */
export type CommandRunner = (spec: RepoCommand) => Promise<RepoCommandResult>;

/**
 * Run `arm`'s check command from `root` with the run's facts on its
 * standard input, and read its verdict. Every way it does not answer is
 * `unread`, with the reason.
 */
export async function runCheck(
  arm: RepoArm & { checkCommand: string },
  facts: Facts,
  root: string,
  runner: CommandRunner,
): Promise<CheckAnswer> {
  const name = `the check command of ${FIELD} (${arm.id})`;
  const timeout = readTimeoutEnv(
    FOLLOWUP_CHECK_TIMEOUT_ENV,
    DEFAULT_FOLLOWUP_CHECK_TIMEOUT_SEC,
  );
  if (!timeout.ok)
    return unread(
      `${FOLLOWUP_CHECK_TIMEOUT_ENV} must be a whole number of seconds from 1 to 2147483, not ${JSON.stringify(timeout.raw)}, so ${name} was not run`,
    );
  const result = await runner({
    command: arm.checkCommand,
    cwd: root,
    stdin: JSON.stringify(facts),
    timeoutSec: timeout.seconds,
    name,
  });
  if (result.kind === "failed")
    return unread(
      /still running/.test(result.reason)
        ? `${result.reason}; ${FOLLOWUP_CHECK_TIMEOUT_ENV} sets the bound`
        : result.reason,
    );
  if (result.code !== 0)
    return unread(
      `${name} exited ${result.code}${result.stderrTail === "" ? "" : `: ${result.stderrTail}`}`,
    );
  return readCheckOutput(name, result.stdout);
}
