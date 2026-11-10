/**
 * Pull request state labels: the state of a pull request's drive or
 * follow-up shown on the pull request, and the commands a person gives from
 * anywhere the forge shows one. Every name carries the repository's prefix
 * (`dispatch.labels.prefix`, `jig:` by default).
 *
 * This is the one projection from a drive ledger to its state label. Three
 * writers use it, each when what it owns changes: the drive when its ledger
 * does (`drive-pr`), the follow-up when it ends, and the dispatcher's tick,
 * which projects every managed pull request again and corrects any label
 * that disagrees. None of them reads a state label to decide what to start.
 *
 * - **States**: `driving`, `converged`, `parked`, `stale`, `held`,
 *   `followed-up`, `followup-failed`. The ledger is the truth: a state label
 *   a person edited, or one a killed drive left behind, is corrected at the
 *   next tick. `held` is the one open state the ledger does not give: a pull
 *   request waiting its turn in a serialized change area carries it whatever
 *   its ledger says. A merged pull request's state comes from its
 *   follow-up's end instead.
 * - **Commands**, read by the tick and never added by a writer: `drive`
 *   adopts a pull request with no drive ledger, `rearm` asks for a stopped
 *   drive to be re-armed in its existing tree, and `hold` stands the
 *   dispatcher and the drive's own label writes down from a pull request
 *   while it is there. `drive` is carried out once a ledger exists and is
 *   then replaced by the state label. `hold` is only ever removed by a
 *   person.
 *
 * This module is pure: the label set, which state a ledger maps to, and
 * what must change on a pull request whose labels disagree. The writers
 * read and write the forge themselves.
 */

/** A repository's `dispatch.labels`. */
export interface LabelConfig {
  /** Off by default: no label is read or written. */
  enabled: boolean;
  /** Put before every name; the labels must exist under it before anything writes them. */
  prefix: string;
  /** The dispatcher reads and acts on only the pull requests that carry a label of the set. */
  onlyLabeled: boolean;
}

export const DEFAULT_LABELS: LabelConfig = {
  enabled: false,
  prefix: "jig:",
  onlyLabeled: false,
};

/**
 * The state labels the projection keeps current: each managed pull
 * request carries at most one of them. A state outside this list (one a
 * later stage owns, which no ledger produces) is never added or removed
 * by the projection.
 */
export const PROJECTED_STATES = [
  "driving",
  "converged",
  "parked",
  "stale",
  "held",
  "followed-up",
  "followup-failed",
] as const;
export type StateName = (typeof PROJECTED_STATES)[number];

/** The labels a person writes and the tick reads. */
export const COMMANDS = ["drive", "rearm", "hold"] as const;
export type CommandName = (typeof COMMANDS)[number];

/** What each label says, for the label setup, which creates them. */
const MEANINGS: Record<StateName | CommandName, string> = {
  driving:
    "A drive runs on this pull request, or the dispatcher re-arms the one that stopped",
  converged: "The drive converged at the pull request's head: a person merges",
  parked: "The drive stopped on something only a person settles",
  stale:
    "Its drive converged then went stale, or stopped or parked on a conflict: the dispatcher re-drives it",
  held: "Waits its turn in a serialized change area: the dispatcher drives it once it leads",
  "followed-up": "Merged, and its follow-up is done",
  "followup-failed": "Merged, and its follow-up failed: a person acts",
  drive: "A person asks the dispatcher to drive this pull request",
  rearm:
    "A person asks the dispatcher to re-arm a stopped drive in its existing tree",
  hold: "A person stands the dispatcher down from this pull request",
};

/** One label of the set, as `gh label create` takes it. */
export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

const STATE_COLOR = "c5def5";
/** Green, so a pull request ready for a person to merge stands out from one still driven. */
const CONVERGED_COLOR = "0e8a16";
/** Red, so a pull request waiting on a person stands out from one still driven or followed up. */
const PARKED_COLOR = "d93f0b";
const COMMAND_COLOR = "fbca04";

/** The states that have a color of their own; the rest take `STATE_COLOR`. */
const STATE_COLORS: Partial<Record<StateName, string>> = {
  converged: CONVERGED_COLOR,
  parked: PARKED_COLOR,
  "followup-failed": PARKED_COLOR,
};

/** The longest label name the forge takes, in characters. */
export const MAX_LABEL = 50;

/** The longest name the prefix goes before: a prefix leaves room for it within the forge's 50 characters. */
export const LONGEST_NAME = Math.max(
  ...[...PROJECTED_STATES, ...COMMANDS].map((n) => n.length),
);

/** The full name of one label under the repository's prefix. */
export function labelName(
  config: Pick<LabelConfig, "prefix">,
  name: StateName | CommandName,
): string {
  return `${config.prefix}${name}`;
}

/** Every label of the set, states first. */
export function labelSet(config: LabelConfig): LabelSpec[] {
  return [
    ...PROJECTED_STATES.map((s) => ({
      name: labelName(config, s),
      color: STATE_COLORS[s] ?? STATE_COLOR,
      description: MEANINGS[s],
    })),
    ...COMMANDS.map((c) => ({
      name: labelName(config, c),
      color: COMMAND_COLOR,
      description: MEANINGS[c],
    })),
  ];
}

/** Whether a pull request's labels include one of the set: with `only_labeled`, the only pull requests the tick reads. */
export function carriesSet(
  config: LabelConfig,
  labels: readonly string[],
): boolean {
  const names = new Set(labelSet(config).map((l) => l.name));
  return labels.some((l) => names.has(l));
}

/** A command label's full name under the repository's prefix (`jig:hold`). */
export function commandLabel(
  config: LabelConfig,
  command: CommandName,
): string {
  return labelName(config, command);
}

export function hasCommand(
  config: LabelConfig,
  labels: readonly string[] | undefined,
  command: CommandName,
): boolean {
  return (labels ?? []).includes(labelName(config, command));
}

/**
 * How a drive ledger reads, as the dispatcher classifies it
 * (`dispatch/lib/sources/ledgers.ts`): the input of the projection.
 */
export type LedgerClass =
  | "driven"
  | "silent"
  | "stale"
  | "done"
  | "stopped-by-person"
  | "stopped-unknown"
  | "re-armable"
  | "parked"
  | "refused"
  | "needs-person"
  | "unarmed"
  | "unplaced";

/**
 * The state a pull request's labels should show: one state, none (no
 * ledger, so no state label), or `unknown` when the writer cannot tell and
 * the labels are left as they are.
 */
export type Projected = { state: StateName | null } | "unknown";

const BY_CLASS: Record<
  Exclude<LedgerClass, "done">,
  StateName | null | "unknown"
> = {
  driven: "driving",
  silent: "parked",
  refused: "driving",
  "re-armable": "driving",
  stale: "stale",
  parked: "parked",
  "needs-person": "parked",
  "stopped-unknown": "parked",
  "stopped-by-person": "parked",
  unarmed: null,
  unplaced: "unknown",
};

/**
 * The drive exits a `done` ledger is read by, as drive-pr's terminal-state
 * registry gives them: the caller passes them in, so this module names no
 * exit code of its own.
 */
export interface DoneExits {
  converged: number;
  takenOver: number;
}

/** A drive ledger as the projection reads it: its class, and the exit it stopped with. */
export interface LedgerReading {
  class: LedgerClass;
  exit?: number | string | boolean | null | undefined;
}

/**
 * The state an open pull request's ledger maps to; `undefined` is a pull
 * request read for a ledger that carries none. A `done` ledger is
 * converged when it stopped `CONVERGED` and driven by another clone when
 * it stopped `TAKEN_OVER`; one that stopped otherwise (merged or closed,
 * on a pull request open again) is left as it is.
 */
export function ledgerState(
  ledger: LedgerReading | undefined,
  exits: DoneExits,
): Projected {
  if (ledger === undefined) return { state: null };
  if (ledger.class === "done") {
    if (ledger.exit === exits.converged) return { state: "converged" };
    if (ledger.exit === exits.takenOver) return { state: "driving" };
    return "unknown";
  }
  const mapped = BY_CLASS[ledger.class];
  return mapped === "unknown" ? "unknown" : { state: mapped };
}

/** What a writer changes on one pull request: the labels to add and to remove, in one call. */
export interface LabelChange {
  pr: number;
  add: string[];
  remove: string[];
  /** `markers` for a change to the owed-steps and follow-up markers, which fails and backs off apart from the state's. */
  part?: "markers";
}

/**
 * What must change on one pull request so its labels agree with
 * `projected`; `null` when they already do. `consumeDrive` removes the
 * `drive` command, which a pull request with a readable ledger has had
 * carried out; it stays while the state is `unknown`, so the pull request
 * keeps its membership of the set until a state can replace it. `hold` is never touched.
 */
export function labelChange(
  config: LabelConfig,
  pr: number,
  labels: readonly string[],
  projected: Projected,
  consumeDrive: boolean,
): LabelChange | null {
  const { add, remove } = stateChange(config, labels, projected);
  if (
    consumeDrive &&
    projected !== "unknown" &&
    hasCommand(config, labels, "drive")
  )
    remove.push(labelName(config, "drive"));
  return add.length === 0 && remove.length === 0 ? null : { pr, add, remove };
}

/** The state labels to add and remove so a pull request carries `projected`'s state alone; none when it is unknown. */
function stateChange(
  config: LabelConfig,
  labels: readonly string[],
  projected: Projected,
): { add: string[]; remove: string[] } {
  if (projected === "unknown") return { add: [], remove: [] };
  const want =
    projected.state === null ? null : labelName(config, projected.state);
  const remove = PROJECTED_STATES.map((s) => labelName(config, s)).filter(
    (name) => name !== want && labels.includes(name),
  );
  const add = want === null || labels.includes(want) ? [] : [want];
  return { add, remove };
}
