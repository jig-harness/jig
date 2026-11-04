/**
 * The operator vocabulary: words, each with one key cap, that group what
 * the records say. A row always prints its recorded word; the mark beside it
 * says what kind of fact that word is. The legend is built from this mapping,
 * so it cannot drift from what the rows show.
 */

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
    meaning: "The line waits on a human and nothing else will move it.",
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
    waiting: "waiting",
    drifting: "waiting",
    "stopped-unknown": "needs",
  },
  "launch record": {
    alive: "working",
    pending: "waiting",
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

/** One mark per stage. */
const STAGES: Record<string, string> = {
  pickup: "+",
  rearm: "↻",
  takeover: "⇄",
  followup: "»",
  notify: "*",
  steer: "^",
};

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

/** A stage's mark; a stage with none shows its name alone. */
export function stageMark(stage: string): string {
  return Object.hasOwn(STAGES, stage) ? (STAGES[stage] ?? "") : "";
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

export const STAGE_LEGEND = Object.entries(STAGES).map(([name, mark]) => ({
  name,
  mark,
}));

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
