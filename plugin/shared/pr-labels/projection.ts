/**
 * Pull request state labels: the state of a pull request's drive or
 * follow-up shown on the pull request, and the commands a person gives from
 * anywhere the forge shows one. Every name carries the repository's prefix
 * (`dispatch.labels.prefix`, `jig:` by default).
 *
 * This is the one projection from a drive ledger to its state label. The
 * drive, the follow-up and the dispatcher's tick write through it, each when
 * what it owns changes: the drive when it writes its ledger (`drive-pr`),
 * the follow-up when it ends, and the tick,
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

/** Who writes a state label: a drive, a follow-up, or the dispatcher's tick. */
export type LabelWriter = "drive" | "followup" | "tick";

/** A label of the set: what it says, which the label setup gives it as its description. */
export interface LabelValue {
  readonly meaning: string;
}

/**
 * A state label, with every writer that adds it and its color. A state
 * that signals a problem (one a person must act on, not one that waits on
 * them as a matter of course) takes a color of the alert family, red to
 * orange, that no other label of the set shares; green is `converged`'s
 * alone. `pr-label-colors.test.ts` holds the set to these rules.
 */
export interface StateLabel extends LabelValue {
  readonly writers: readonly LabelWriter[];
  readonly problem: boolean;
  /** Six hex digits, as `gh label create --color` takes it. */
  readonly color: string;
}

/** The color of a state that needs no color of its own. */
const STATE_COLOR = "c5def5";

/**
 * The state labels the projection keeps current: each managed pull
 * request carries at most one of them. A state outside this list (one a
 * later stage owns, which no ledger produces) is never added or removed
 * by the projection. The tick writes every state; a drive and a follow-up
 * write only their own (`write.ts`).
 */
export const STATE_LABELS = {
  driving: {
    writers: ["drive", "tick"],
    problem: false,
    color: STATE_COLOR,
    meaning:
      "A drive runs on this pull request, or the dispatcher re-arms the one that stopped",
  },
  converged: {
    writers: ["drive", "tick"],
    problem: false,
    /** Green, so a pull request ready for a person to merge stands out from one still driven. */
    color: "0e8a16",
    meaning: "The drive converged at the pull request's head: a person merges",
  },
  parked: {
    writers: ["drive", "tick"],
    problem: true,
    /** Red, so a pull request waiting on a person's answer stands out from one still driven or followed up. */
    color: "d93f0b",
    meaning: "The drive stopped on something only a person settles",
  },
  stale: {
    writers: ["tick"],
    problem: false,
    color: STATE_COLOR,
    meaning:
      "Its drive converged then went stale, or stopped or parked on a conflict: the dispatcher re-drives it",
  },
  held: {
    writers: ["tick"],
    problem: false,
    color: STATE_COLOR,
    meaning:
      "Waits its turn in a serialized change area: the dispatcher drives it once it leads",
  },
  "followed-up": {
    writers: ["followup", "tick"],
    problem: false,
    color: STATE_COLOR,
    meaning: "Merged, and its follow-up is done",
  },
  "followup-failed": {
    writers: ["followup", "tick"],
    problem: true,
    /** Crimson, so a failed follow-up stands out from a parked drive: each calls for a different act. */
    color: "a40e4c",
    meaning: "Merged, and its follow-up failed: a person acts",
  },
} as const satisfies Readonly<Record<string, StateLabel>>;
export type StateName = keyof typeof STATE_LABELS;
export const PROJECTED_STATES = Object.keys(
  STATE_LABELS,
) as readonly StateName[];

/** The labels a person writes and the tick reads. */
export const COMMAND_LABELS = {
  drive: {
    meaning: "A person asks the dispatcher to drive this pull request",
  },
  rearm: {
    meaning:
      "A person asks the dispatcher to re-arm a stopped drive in its existing tree",
  },
  hold: {
    meaning: "A person stands the dispatcher down from this pull request",
  },
} as const satisfies Readonly<Record<string, LabelValue>>;
export type CommandName = keyof typeof COMMAND_LABELS;
export const COMMANDS = Object.keys(COMMAND_LABELS) as readonly CommandName[];

/** The states `writer` adds; the tick adds every state. */
export function statesWrittenBy(writer: LabelWriter): StateName[] {
  return PROJECTED_STATES.filter((s) =>
    (STATE_LABELS[s].writers as readonly LabelWriter[]).includes(writer),
  );
}

/** One label of the set, as `gh label create` takes it. */
export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

const COMMAND_COLOR = "fbca04";

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
      color: STATE_LABELS[s].color,
      description: STATE_LABELS[s].meaning,
    })),
    ...COMMANDS.map((c) => ({
      name: labelName(config, c),
      color: COMMAND_COLOR,
      description: COMMAND_LABELS[c].meaning,
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
