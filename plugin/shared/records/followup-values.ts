/**
 * The closed values of the follow-up marker (`dispatch-followup`,
 * `launch-claims.ts`): the runs that take a merged pull request's follow-up,
 * the outcomes each run's marker carries, and the fields of the marker's
 * payload, each with what it means to a reader. The marker's writers and
 * readers take their types and checks from these tables, and the dispatcher's
 * outcome record (`dispatch/lib/followup-outcomes.ts`) its outcome; the Jig
 * Protocol's chapter on the follow-up claim and its result
 * (`plugin/protocol/followup-claim.md`) is generated from them.
 *
 * Nothing here imports anything, so the chapter's generator reads the tables
 * without loading the dispatcher.
 */

/** A value of one of the tables, with what it means to a reader that branches on it. */
export interface FollowupValue {
  readonly meaning: string;
}

/** The runs a follow-up marker names in its `run` field. */
export const FOLLOWUP_RUNS = {
  tick: {
    meaning:
      "A dispatcher's tick took the follow-up: its marker names the launch record of the session the tick started and the host that started it, and that host writes the follow-up's outcome onto the marker once the launch record ends.",
  },
  manual: {
    meaning:
      "A person ran the follow-up, and its run posted the marker through `jig dispatch marker claim`: the run writes its own outcome onto it (`jig dispatch marker done`).",
  },
} as const satisfies Readonly<Record<string, FollowupValue>>;

export type FollowupRun = keyof typeof FOLLOWUP_RUNS;

/** The outcomes each run's marker carries in its `outcome` field. */
export const FOLLOWUP_OUTCOMES = {
  tick: {
    done: {
      meaning:
        "The follow-up's session recorded its result as done (`jig dispatch result`): the follow-up is finished, and nothing starts it again.",
    },
    failed: {
      meaning:
        "The follow-up's session ended without recording done, or its launch died and is not retried: a person acts, and the marker keeps holding the follow-up against every later one until a person marks it done or deletes it, or the dispatcher's recovery releases it once, as for a rate-limit wait or a routine that failed.",
    },
  },
  manual: {
    running: {
      meaning:
        "A person's run claimed the follow-up and has not finished its last act. It holds the follow-up against every later run; a run that failed leaves it so (`jig dispatch marker failed`) until a person marks it done or deletes it, or the dispatcher releases a stale one once.",
    },
    done: {
      meaning:
        "A person's run finished its last act (`jig dispatch marker done`): the follow-up is finished.",
    },
  },
} as const satisfies Readonly<
  Record<FollowupRun, Readonly<Record<string, FollowupValue>>>
>;

/** The outcome a tick's marker carries once its host wrote the end: the follow-up's answer. */
export type TickOutcome = keyof (typeof FOLLOWUP_OUTCOMES)["tick"];
/** The outcome a manual run's marker carries. */
export type ManualOutcome = keyof (typeof FOLLOWUP_OUTCOMES)["manual"];

/** Whether `value` is one of `run`'s outcomes. */
export function isOutcomeOf<R extends FollowupRun>(
  run: R,
  value: unknown,
): value is keyof (typeof FOLLOWUP_OUTCOMES)[R] {
  return (
    typeof value === "string" && Object.hasOwn(FOLLOWUP_OUTCOMES[run], value)
  );
}

/** Whether `value` names one of the runs. */
export function isFollowupRun(value: unknown): value is FollowupRun {
  return typeof value === "string" && Object.hasOwn(FOLLOWUP_RUNS, value);
}

/** Whether a run's marker carries a field: on every marker, on some, or never (absent). */
export type Carried = "always" | "sometimes";

/** A field of the marker's payload: which runs' markers carry it, and what it says. */
export interface FollowupField extends FollowupValue {
  /** The JSON type of the field's value. */
  readonly type: "string" | "integer" | "boolean";
  readonly carriedBy: Readonly<Partial<Record<FollowupRun, Carried>>>;
}

/**
 * The fields of the marker's payload, beside the record envelope's. The
 * writers in `launch-claims.ts` write no other, and its tests hold each
 * run's markers to the fields this table says they carry.
 */
export const FOLLOWUP_FIELDS = {
  pr: {
    type: "integer",
    carriedBy: { tick: "always", manual: "always" },
    meaning:
      "The number of the pull request the marker is on; a marker whose record names another pull request does not read.",
  },
  run: {
    type: "string",
    carriedBy: { tick: "always", manual: "always" },
    meaning: "Which run took the follow-up: one of the runs listed above.",
  },
  record: {
    type: "string",
    carriedBy: { tick: "always" },
    meaning:
      "The launch record of the session the tick started, in the dispatcher's form `<yyyymmdd>T<hhmmss>Z-<8 hex>`.",
  },
  host: {
    type: "string",
    carriedBy: { tick: "sometimes" },
    meaning:
      "The host whose tick took the follow-up, as a digest of its dispatcher's database instance: a public comment names no machine, and that host recognises its own marker. A marker posted before markers named their host carries none until the host that ends it writes its own.",
  },
  owner: {
    type: "boolean",
    carriedBy: { tick: "sometimes" },
    meaning:
      "Whether the host that took the follow-up owns the repository's board, notifications and history rows; absent where that host does not say.",
  },
  outcome: {
    type: "string",
    carriedBy: { tick: "sometimes", manual: "always" },
    meaning:
      "Where the follow-up stands: one of the outcomes listed above for the marker's run. A tick's marker carries none until its host writes the end.",
  },
  endedAt: {
    type: "string",
    carriedBy: { tick: "sometimes" },
    meaning:
      "When the follow-up's launch ended, as an ISO 8601 time, written by its host with the outcome.",
  },
  by: {
    type: "string",
    carriedBy: { tick: "sometimes" },
    meaning:
      "Who wrote the follow-up run's closing report (agent, driver, wrapper, steward or person), or none when it left none, written by its host with the outcome. The report's own text stays on that host.",
  },
  cause: {
    type: "string",
    carriedBy: { tick: "sometimes" },
    meaning:
      "Why the follow-up run fell short, from the closing report's closed list of causes, written by its host with the outcome when the report named one.",
  },
} as const satisfies Readonly<Record<string, FollowupField>>;

export type FollowupFieldName = keyof typeof FOLLOWUP_FIELDS;

/** A follow-up marker's payload as its writers build it: only the fields the table lists. */
export type FollowupPayload = { readonly [F in FollowupFieldName]?: unknown };
