/**
 * How the GitHub adapter reads the port's vocabulary off a GitHub issue:
 * its workflow state, its priority, and which of its labels are ordinary
 * labels.
 *
 * GitHub knows only open and closed, with a reason for closing. The closed
 * states come from that reason: completed (or no reason) is `done`, not
 * planned is `canceled`, duplicate is `duplicate`. The open states come from
 * one of two places, `issue_tracker.github.states_from`:
 *
 * - `labels`: a label per state, named by `issue_tracker.states`. `todo` is
 *   the state with no label, so a new issue reads as `todo`; a state named
 *   like `todo` (an alias) carries no label either. An issue carrying several
 *   state labels reads as the furthest along.
 * - `project`: the option of a Projects board's single-select field
 *   (`status_field`, default `Status`) named by `issue_tracker.states`. An
 *   open issue that is not on the board, or has no option set, reads as
 *   `todo`; an option that names no open state is refused, since reading it
 *   as `todo` would offer the issue for pickup.
 *
 * Priority is a label per level (`priority_labels`); none of them is 0. The
 * state labels and the priority labels are the state and the priority, so
 * they are left out of an issue's labels.
 */

import {
  type GitHubSettings,
  PRIORITY_NAMES,
  type PriorityName,
} from "./settings.ts";
import {
  type CanonicalState,
  type IssueState,
  type StateNameOf,
  type StateNames,
  stateNameIn,
} from "../port.ts";
import { TrackerConfigError } from "../config-error.ts";

/** The open states, from least to furthest along. */
export const OPEN_STATES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "pr_open",
  "blocked",
  "in_review",
  "ops_pending",
] as const satisfies ReadonlyArray<CanonicalState>;

/** The close reason GitHub records for each closed state. */
export const CLOSE_REASONS = {
  done: "COMPLETED",
  canceled: "NOT_PLANNED",
  duplicate: "DUPLICATE",
} as const satisfies Partial<Record<CanonicalState, string>>;

export type ClosedState = keyof typeof CLOSE_REASONS;

export function isClosedState(s: CanonicalState): s is ClosedState {
  return Object.hasOwn(CLOSE_REASONS, s);
}

/** The state category of each canonical state, in the port's vocabulary. */
export const STATE_TYPES: Record<CanonicalState, string> = {
  triage: "triage",
  backlog: "backlog",
  todo: "unstarted",
  in_progress: "started",
  pr_open: "started",
  blocked: "started",
  in_review: "started",
  ops_pending: "started",
  done: "completed",
  canceled: "canceled",
  duplicate: "duplicate",
};

/** What the model needs of one issue. */
export interface StateInput {
  open: boolean;
  /** GitHub's close reason (`COMPLETED`, `NOT_PLANNED`, `DUPLICATE`), or `null`. */
  stateReason: string | null;
  /** Every label, state and priority labels included. */
  labels: string[];
  /** The board's option for the issue (project mode); `null` = none or not on the board. */
  status: string | null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface GitHubModel {
  stateName: StateNameOf;
  /** The canonical state an issue is in. */
  stateOf(issue: StateInput): CanonicalState;
  /** The port's view of that state. */
  issueState(issue: StateInput): IssueState;
  /** 0 = none, then 1 (urgent) to 4 (low). */
  priorityOf(labels: string[]): number;
  /** The issue's labels without its state and priority labels. */
  visibleLabels(labels: string[]): string[];
  /** Is `label` a state label or a priority label? */
  isReserved(label: string): boolean;
  /** The label a priority is written as; `null` for 0. */
  priorityLabel(priority: number): string | null;
  /** Every priority label, each priority's aliases included. */
  readonly priorityLabels: string[];
  /**
   * The label an open state carries in labels mode, or `null` for a state
   * that carries none (`todo`, any state named like it, and an optional
   * state left unset).
   */
  stateLabel(state: (typeof OPEN_STATES)[number]): string | null;
  /** Every label that stands for a state, in labels mode; none in project mode. */
  readonly stateLabels: string[];
}

export function gitHubModel(
  states: StateNames,
  settings: GitHubSettings,
): GitHubModel {
  const labelsMode = settings.statesFrom === "labels";
  const stateLabel = (s: (typeof OPEN_STATES)[number]): string | null => {
    const name = states[s];
    return !labelsMode || name === null || same(name, states.todo)
      ? null
      : name;
  };
  const stateLabels = labelsMode
    ? [
        ...new Set(
          OPEN_STATES.map(stateLabel).filter((l): l is string => l !== null),
        ),
      ]
    : [];
  const priorityLabels = PRIORITY_NAMES.flatMap(
    (p) => settings.priorityLabels[p],
  );
  const isReserved = (label: string) =>
    stateLabels.some((l) => same(l, label)) ||
    priorityLabels.some((l) => same(l, label));

  /**
   * Whether an issue carrying `names` is in open state `s`. A name `pr_open`
   * shares with `in_review` reads as `pr_open` alone.
   */
  function carries(s: (typeof OPEN_STATES)[number], names: string[]): boolean {
    const carried = labelsMode ? stateLabel(s) : states[s];
    if (carried === null || !names.some((n) => same(n, carried))) return false;
    const prOpen = states.pr_open;
    return s === "pr_open" || prOpen === null || !same(carried, prOpen);
  }

  function openStateOf(issue: StateInput): CanonicalState {
    const names = labelsMode
      ? issue.labels
      : issue.status === null
        ? []
        : [issue.status];
    const found = OPEN_STATES.filter((s) => carries(s, names)).at(-1) ?? null;
    if (found === null && !labelsMode) refuseUnmapped(issue.status);
    return found ?? "todo";
  }

  /** Refuse a board option that names no open state; no option is `todo`. */
  function refuseUnmapped(status: string | null): void {
    if (status !== null)
      throw new TrackerConfigError(
        "issue_tracker.states",
        `the ${settings.statusField} option '${status}' names no open state in issue_tracker.states; map it to one, or move the issue to an option that does`,
      );
  }

  function stateOf(issue: StateInput): CanonicalState {
    if (issue.open) return openStateOf(issue);
    if (issue.stateReason === "NOT_PLANNED") return "canceled";
    if (issue.stateReason === "DUPLICATE") return "duplicate";
    return "done";
  }

  return {
    stateName: stateNameIn(states),
    stateOf,
    issueState: (issue) => {
      const s = stateOf(issue);
      return { name: states[s] ?? "", type: STATE_TYPES[s] };
    },
    priorityOf: (labels) => {
      for (const [i, p] of PRIORITY_NAMES.entries())
        if (
          labels.some((l) =>
            settings.priorityLabels[p].some((name) => same(l, name)),
          )
        )
          return i + 1;
      return 0;
    },
    visibleLabels: (labels) => labels.filter((l) => !isReserved(l)),
    isReserved,
    priorityLabel: (priority) =>
      priority === 0
        ? null
        : (settings.priorityLabels[
            PRIORITY_NAMES[priority - 1] as PriorityName
          ][0] as string),
    priorityLabels,
    stateLabel,
    stateLabels,
  };
}
