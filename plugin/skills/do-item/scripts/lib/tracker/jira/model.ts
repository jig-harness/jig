/**
 * How the Jira adapter reads the port's vocabulary off a Jira issue: its
 * workflow state and its priority.
 *
 * A Jira status belongs to the project's workflow and sits in one of three
 * categories: `new` (To Do), `indeterminate` (In Progress) and `done`. A
 * status reads as the canonical state `issue_tracker.states` names like it,
 * ignoring case; a status no state names keeps its own name, with the type
 * its category gives (`unstarted`, `started`, `completed`), so a workflow
 * needs no mapping for every status it has.
 *
 * A status in the done category is always closed one way or another. One
 * `Done` status with the resolutions Done, Won't Do and Duplicate is the
 * common Jira shape, so when the status name does not tell `done`,
 * `canceled` and `duplicate` apart, the resolution
 * (`issue_tracker.jira.resolutions`) does; with neither, it is `done`.
 *
 * Priority is the issue's priority name, numbered by
 * `issue_tracker.jira.priorities`; any other name reads as 0 (none).
 */

import type { CanonicalState, IssueState } from "../port.ts";
import { OPEN_STATES, STATE_TYPES } from "../github/model.ts";
import {
  type JiraSettings,
  PRIORITY_NAMES,
  RESOLVED_STATES,
  type ResolvedState,
} from "./settings.ts";

export { STATE_TYPES };

/** A status as an issue carries it. */
export interface JiraStatus {
  id: string;
  name: string;
  /** `new`, `indeterminate` or `done`; anything else reads as `new`. */
  category: string;
}

/** What the model needs of one issue. */
export interface StateInput {
  status: JiraStatus;
  /** The resolution's name; `null` when unresolved. */
  resolution: string | null;
}

/** The state an issue is in: its canonical state when one names it. */
export interface ReadState {
  /** `null` = an open status no state names. */
  canonical: CanonicalState | null;
  /** The port's view: a named state's configured name, else the status's own. */
  state: IssueState;
}

const CATEGORY_TYPES: Record<string, string> = {
  new: "unstarted",
  indeterminate: "started",
  done: "completed",
};

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** The categories an open state's type belongs to. */
const OPEN_CATEGORY: Record<string, string> = {
  triage: "new",
  backlog: "new",
  unstarted: "new",
  started: "indeterminate",
};

export interface JiraModel {
  stateName(state: CanonicalState): string;
  /** The state an issue is in. */
  read(issue: StateInput): ReadState;
  /** The closed state of a done-category issue. */
  closedState(issue: StateInput): ResolvedState;
  /** 0 = none, then 1 (urgent) to 4 (low). */
  priorityOf(name: string | null): number;
  /** The priority name a number stands for; `null` for 0. */
  priorityName(priority: number): string | null;
  /** The resolution a closed state is given on its transition. */
  resolutionOf(state: ResolvedState): string;
}

export function isResolvedState(s: CanonicalState): s is ResolvedState {
  return (RESOLVED_STATES as readonly string[]).includes(s);
}

export function jiraModel(
  states: Record<CanonicalState, string>,
  settings: JiraSettings,
): JiraModel {
  function closedState(issue: StateInput): ResolvedState {
    const named = RESOLVED_STATES.filter((s) =>
      same(states[s], issue.status.name),
    );
    if (named.length === 1) return named[0] as ResolvedState;
    const resolution = issue.resolution;
    if (resolution !== null) {
      if (same(settings.resolutions.canceled, resolution)) return "canceled";
      if (same(settings.resolutions.duplicate, resolution)) return "duplicate";
    }
    return "done";
  }

  /**
   * The open state named like the status, furthest along among those whose
   * type fits the status's category (else among all named like it).
   */
  function openState(status: JiraStatus): CanonicalState | null {
    const named = OPEN_STATES.filter((s) => same(states[s], status.name));
    const category =
      status.category === "indeterminate" ? "indeterminate" : "new";
    const fitting = named.filter(
      (s) => OPEN_CATEGORY[STATE_TYPES[s]] === category,
    );
    return (fitting.length > 0 ? fitting : named).at(-1) ?? null;
  }

  return {
    stateName: (s) => states[s],
    closedState,
    read(issue) {
      if (issue.status.category === "done") {
        const s = closedState(issue);
        return {
          canonical: s,
          state: { name: states[s], type: STATE_TYPES[s] },
        };
      }
      const s = openState(issue.status);
      if (s !== null)
        return {
          canonical: s,
          state: { name: states[s], type: STATE_TYPES[s] },
        };
      return {
        canonical: null,
        state: {
          name: issue.status.name,
          type: CATEGORY_TYPES[issue.status.category] ?? "unstarted",
        },
      };
    },
    priorityOf(name) {
      if (name === null) return 0;
      const i = PRIORITY_NAMES.findIndex((p) =>
        same(settings.priorities[p], name),
      );
      return i < 0 ? 0 : i + 1;
    },
    priorityName: (priority) =>
      priority < 1 || priority > 4
        ? null
        : settings.priorities[
            PRIORITY_NAMES[priority - 1] as (typeof PRIORITY_NAMES)[number]
          ],
    resolutionOf: (s) => settings.resolutions[s],
  };
}
