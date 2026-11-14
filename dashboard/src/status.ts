/**
 * The operator vocabulary: words, each with one key cap, that group what
 * the records say. A row always prints its recorded word; the mark beside it
 * says what kind of fact that word is. The legend is built from this mapping,
 * so it cannot drift from what the rows show.
 */
import type { Stage } from "./icons.ts";

export type RoleKey =
  | "needs"
  | "working"
  | "waiting"
  | "held"
  | "well"
  | "badly"
  | "stale"
  | "unknown";

export interface Role {
  word: string;
  glyph: string;
  /** The role's class in the stylesheet. */
  rc: string;
  meaning: string;
}

export const ROLES: Record<RoleKey, Role> = {
  needs: {
    word: "needs a person",
    glyph: "",
    rc: "r-needs",
    meaning: "The work waits on a person and nothing else will move it.",
  },
  working: {
    word: "working",
    glyph: "~",
    rc: "r-working",
    meaning: "A session holds its slot and progresses as expected.",
  },
  waiting: {
    word: "waiting",
    glyph: "…",
    rc: "r-waiting",
    meaning: "A session is alive but not progressing, or past an expectation.",
  },
  held: {
    word: "held back",
    glyph: "=",
    rc: "r-held",
    meaning: "The dispatcher chose, by rule, not to start it.",
  },
  well: {
    word: "finished well",
    glyph: "✓",
    rc: "r-well",
    meaning: "The stage achieved what it was started for.",
  },
  badly: {
    word: "finished badly",
    glyph: "×",
    rc: "r-badly",
    meaning: "The stage ended without achieving it.",
  },
  stale: {
    word: "stale",
    glyph: "≠",
    rc: "r-stale",
    meaning: "Finished well once, and the world moved.",
  },
  unknown: {
    word: "unknown",
    glyph: "?",
    rc: "r-unknown",
    meaning: "The dispatcher cannot tell.",
  },
};

export type RecordedSet =
  | "outcome class"
  | "ledger class"
  | "notify cause"
  | "launch record"
  | "agent state"
  | "launch outcome"
  | "label";

/** Which role each recorded word belongs to, per set of records. */
const RECORDED: Record<RecordedSet, Record<string, RoleKey>> = {
  "outcome class": {
    "parked for a person": "needs",
    converged: "well",
    merged: "well",
    "gates failed": "badly",
    died: "badly",
    stalled: "badly",
    refused: "badly",
    "quota wall": "badly",
    "double claim": "badly",
    unknown: "badly",
  },
  "ledger class": {
    parked: "needs",
    "needs-person": "needs",
    "stopped-unknown": "needs",
    driven: "working",
    silent: "waiting",
    held: "held",
    "re-armable": "held",
    "stopped-by-person": "held",
    unarmed: "held",
    unplaced: "held",
    done: "well",
    stale: "stale",
    refused: "badly",
  },
  "notify cause": {
    parked: "needs",
    "needs-person": "needs",
    stalled: "needs",
    "double-claim": "needs",
    "followup-failed": "needs",
    "nudge-unanswered": "needs",
    "pickup-question": "needs",
    waiting: "waiting",
    drifting: "waiting",
    "stopped-unknown": "needs",
  },
  "launch record": {
    alive: "working",
    pending: "waiting",
    stuck: "needs",
    unknown: "unknown",
    died: "badly",
  },
  "agent state": {
    working: "working",
    waiting: "waiting",
    blocked: "waiting",
    done: "well",
  },
  "launch outcome": {
    waits: "held",
    refused: "held",
    reported: "held",
    failed: "badly",
    lost: "badly",
  },
  label: {
    parked: "needs",
    driving: "working",
    hold: "held",
    held: "held",
    converged: "well",
    "followed-up": "well",
    stale: "stale",
    unknown: "unknown",
  },
};

/** The words the running panel's readers need, each with what it means. */
export const TERMS: Array<{ word: string; meaning: string }> = [
  {
    word: "slot",
    meaning:
      "One of an account’s concurrent-session places, held by a launch record that is pending, alive or unknown. A takeover and the record it replaces count as one. A parked drive holds none.",
  },
  {
    word: "wall",
    meaning:
      "A subscription account’s usage limit, recorded once a session stops on it. The account is left out of every launch until the wall’s reset.",
  },
  {
    word: "drifting",
    meaning:
      "A running stage outside its expectation: threads not falling, no pull request in time. Reported and notified, never acted on.",
  },
  {
    word: "nudge",
    meaning:
      "The one fixed prompt the dispatcher may send by itself: “continue”, to a session waiting after a usage limit that has since reset.",
  },
];

/** What each stage does, for the popover its chip opens. */
const STAGE_MEANINGS: Record<Stage, string> = {
  pickup:
    "Starting a tracker item assigned to the factory identity: one workspace and one do-item session.",
  rearm:
    "Restarting a stopped drive, the unattended review loop on a pull request, on an account with a free slot.",
  takeover:
    "Replacing a wedged driver: a new session runs in the slot the old one held.",
  followup:
    "After a pull request merges, one session settles what the merge still owes.",
  notify:
    "Telling a person, once per cause, about a stop only a person can settle.",
  steer:
    "The one fixed prompt the dispatcher may send by itself: “continue”, to a session waiting after a usage limit that has since reset.",
  steward:
    "A pass on the owner's host that reads the stopped work and the assigned queue, and records the recoveries it may make and what needs a person.",
};

/** What a stage does; a stage the page does not know says so. */
export function stageMeaning(stage: string): string {
  return Object.hasOwn(STAGE_MEANINGS, stage)
    ? (STAGE_MEANINGS[stage as Stage] ?? "")
    : "A stage this page has no description for.";
}

/** Every stage with what it means, for the help view. */
export const STAGE_LEGEND = Object.entries(STAGE_MEANINGS).map(
  ([name, meaning]) => ({ name, meaning }),
);

/** Where a queued target came from, for the popover its chip opens. */
const SOURCE_MEANINGS: Record<string, string> = {
  "re-armable":
    "A drive the dispatcher may restart by itself: stopped with no recorded cause (re-arming within its budget), on a usage limit, or once every parked item is answered. A drive stopped by a person stays stopped.",
  "label drive":
    "A pull request carrying the drive label, which asks the dispatcher to arm a drive on it.",
  held: "Kept off by a hold label or behind a serialized leader: no stage starts on it while that stands.",
  assigned:
    "A tracker item assigned to the factory identity, waiting for a pickup.",
  merged: "A merged pull request waiting for its follow-up session.",
};

/** Every source with what it means, for the help view. */
export const SOURCE_LEGEND = Object.entries(SOURCE_MEANINGS).map(
  ([name, meaning]) => ({ name, meaning }),
);

/** Where a queued target came from; a source the page does not know says so. */
export function sourceMeaning(source: string): string {
  return Object.hasOwn(SOURCE_MEANINGS, source)
    ? (SOURCE_MEANINGS[source] ?? "")
    : "A source this page has no description for.";
}

/** A recorded word's role; a word the mapping does not place is `unknown`. */
export function roleOf(set: RecordedSet, value: string): Role {
  const table = RECORDED[set];
  return Object.hasOwn(table, value)
    ? ROLES[table[value] ?? "unknown"]
    : ROLES.unknown;
}

/** The role of an observation no class names: its notify cause, else held back. */
export function eventRole(event: string): Role {
  const table = RECORDED["notify cause"];
  return Object.hasOwn(table, event)
    ? ROLES[table[event] ?? "held"]
    : ROLES.held;
}

export interface LegendRole extends Role {
  sets: Array<{ set: string; items: string }>;
}

/** The legend: each role with the recorded words that belong to it, per set. */
export function buildLegend(): LegendRole[] {
  return (Object.keys(ROLES) as RoleKey[]).map((key) => ({
    ...ROLES[key],
    sets: (Object.keys(RECORDED) as RecordedSet[])
      .map((set) => ({
        set,
        items: Object.entries(RECORDED[set])
          .filter(([, role]) => role === key)
          .map(([word]) => word)
          .join(", "),
      }))
      .filter((s) => s.items !== ""),
  }));
}

/** How each computed number on the page is counted. */
export const COUNT_NOTES = [
  {
    k: "class counts",
    v: "Rows the filter keeps, per class, ignoring the class filter itself so another class can be chosen.",
  },
  {
    k: "slots held",
    v: "Launch records pending, alive or unknown on the account, over its cap. A takeover and its replaced record count once.",
  },
  {
    k: "waited",
    v: "From the hold’s beginning event to now, or to its ending event in the log.",
  },
  { k: "duration", v: "Launch to end of the record." },
  { k: "rounds", v: "The ledger’s round at the end less its round at launch." },
  {
    k: "threads",
    v: "Unresolved review threads, the first time a tick saw each round. Unseen rounds are gaps.",
  },
];
