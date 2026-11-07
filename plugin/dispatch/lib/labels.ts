/**
 * Dispatch labels: the dispatcher's state shown on each pull request it
 * manages, and two commands a person gives it from anywhere the forge
 * shows a pull request. Every name carries the repository's prefix
 * (`dispatch.labels.prefix`, `jig:` by default).
 *
 * - **States**, written by the tick and nobody else: `driving`,
 *   `converged`, `parked`, `stale`, `held`, `followed-up`. The ledger is
 *   the truth, and each tick derives the state from it again, so a state
 *   label a person edited, or one a killed drive left behind, is corrected
 *   at the next tick; `held` is the one state the ledger does not give: a
 *   pull request waiting its turn in a serialized change area carries it
 *   whatever its ledger says. Nothing reads a state label to decide what to
 *   start.
 * - **Commands**, read by the tick and never added by it: `drive` adopts a
 *   pull request with no drive ledger (the tick arms a drive on it), and
 *   `hold` stands the dispatcher down from a pull request while it is
 *   there. `drive` is carried out once a ledger exists and is then replaced
 *   by the state label; `hold` is only ever removed by a person.
 *
 * This module is pure: which state a ledger maps to, which pull requests
 * the labels make the tick read, and what must change on a pull request
 * whose labels disagree. `actions/labels.ts` writes the changes.
 */
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { DrivenPr, LedgerClass } from "./types.ts";

/** A repository's `dispatch.labels`. */
export interface LabelConfig {
  /** Off by default: no label is read or written. */
  enabled: boolean;
  /** Put before every name; the labels must exist under it before the tick writes them. */
  prefix: string;
  /** Read and act on only the pull requests that carry a label of the set. */
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
] as const;
export type StateName = (typeof PROJECTED_STATES)[number];

/** The labels a person writes and the tick reads. */
export const COMMANDS = ["drive", "rearm", "hold"] as const;
export type CommandName = (typeof COMMANDS)[number];

/** What each label says, for `jig install dispatch --repo`, which creates them. */
const MEANINGS: Record<StateName | CommandName, string> = {
  driving:
    "A drive runs on this pull request, or the dispatcher re-arms the one that stopped",
  converged: "The drive converged at the pull request's head: a person merges",
  parked: "The drive stopped on something only a person settles",
  stale:
    "Its drive converged then went stale, or stopped on a conflict: the dispatcher re-drives it",
  held: "Waits its turn in a serialized change area: the dispatcher drives it once it leads",
  "followed-up": "Merged, and its follow-up is done",
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
const COMMAND_COLOR = "fbca04";

/** The full name of one label under the repository's prefix. */
function labelName(config: LabelConfig, name: StateName | CommandName): string {
  return `${config.prefix}${name}`;
}

/** Every label of the set, states first. */
export function labelSet(config: LabelConfig): LabelSpec[] {
  return [
    ...PROJECTED_STATES.map((s) => ({
      name: labelName(config, s),
      color: STATE_COLOR,
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
 * The state a pull request's labels should show: one state, none (no
 * ledger, so no state label), or `unknown` when this tick cannot tell and
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
 * The state an open pull request's ledger maps to; `undefined` is a pull
 * request read for a ledger that carries none. A `done` ledger is
 * converged when it stopped `CONVERGED` (`0`) and driven by another clone
 * when it stopped `TAKEN_OVER` (`20`); one that stopped `PR_NOT_OPEN` (`5`)
 * on a pull request open again is left as it is.
 */
export function stateOf(drive: DrivenPr | undefined): Projected {
  if (drive === undefined) return { state: null };
  if (drive.class === "done") {
    const exit = drive.evidence.exit;
    if (exit === DRIVE_EXIT.CONVERGED) return { state: "converged" };
    if (exit === DRIVE_EXIT.TAKEN_OVER) return { state: "driving" };
    return "unknown";
  }
  const mapped = BY_CLASS[drive.class];
  return mapped === "unknown" ? "unknown" : { state: mapped };
}

/** What the tick writes on one pull request: the labels to add and to remove, in one call. */
export interface LabelChange {
  pr: number;
  add: string[];
  remove: string[];
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
