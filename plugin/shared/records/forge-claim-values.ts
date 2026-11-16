/**
 * The fields of forge claims (`forge-claims.ts`): the takeover claim
 * (`drive-takeover-claim`), the dispatcher's launch claim
 * (`dispatch-launch-claim`) and the merge-ready announcement
 * (`drive-merge-ready`), each field with its JSON type, which claims carry it
 * and what it means to a reader; and the closed values of the launch claim's
 * fields. Their readers validate against the shape descriptions beside them
 * (`forge-claim-shapes.ts`), which take their closed lists from here; the Jig
 * Protocol's chapter on forge claims (`plugin/protocol/forge-claims.md`) is
 * generated from both.
 *
 * Nothing here imports anything, so the chapter's generator reads the tables
 * without loading the dispatcher or the drive.
 */

/** A value of one of the tables, with what it means to a reader that meets it. */
export interface ForgeClaimValue {
  readonly meaning: string;
}

/**
 * Which claims of a kind carry a field: every one, some, or, for a field of
 * a launch's end, every end or every end in one state, or some of those.
 */
export type ClaimCarried =
  | "always"
  | "sometimes"
  | "every end"
  | "every ended end"
  | "every died end"
  | "some ended ends"
  | "some died ends";

/** One field of a claim's record, beside the record envelope's own. */
export interface ForgeClaimField extends ForgeClaimValue {
  /** The JSON type of the field's value. */
  readonly type: "string" | "integer" | "boolean" | "object" | "string[]";
  /** Whether `null` is a value the field may carry. */
  readonly nullable?: true;
  readonly carried: ClaimCarried;
}

/**
 * The takeover claim's fields. `generation` is the envelope's own field,
 * listed because the claim always carries it and its key repeats it.
 */
export const TAKEOVER_CLAIM_FIELDS = {
  generation: {
    type: "integer",
    carried: "always",
    meaning:
      "The ledger generation the claimant read before it claimed: the claim's key is `takeover:<generation>`, and of the trusted claims on one generation the earliest wins.",
  },
  actor: {
    type: "string",
    carried: "always",
    meaning:
      "The claiming driver's session, as the drive ledger names its driver: the driver that takes the drive over.",
  },
  clone: {
    type: "string",
    carried: "always",
    meaning:
      "The clone the claiming driver runs in: a driver that finds a claim in force from another clone stops at its next round boundary.",
  },
} as const satisfies Readonly<Record<string, ForgeClaimField>>;

/** The launch claim's closed values: the actions a launch takes, and the states its end is in. */
export const LAUNCH_CLAIM_VALUES = {
  action: {
    rearm: {
      meaning:
        "The launch re-arms the pull request's drive: an arm where no drive ran, a re-arm of a stopped one, or, with `change`, a re-drive.",
    },
    takeover: {
      meaning:
        "The launch takes the drive over from a driver whose ledger still says it runs but whose heartbeat has gone silent past the lease window.",
    },
  },
  "end.state": {
    ended: {
      meaning: "The launch ran and its stage exited: `exit` is the exit.",
    },
    died: {
      meaning:
        "The launch did not run to its exit: `reason` says why, and nothing more is known of its stage.",
    },
  },
} as const satisfies Readonly<
  Record<string, Readonly<Record<string, ForgeClaimValue>>>
>;

/**
 * The launch claim's fields. `generation` is the envelope's own field, the
 * attempt the claim makes; `end` and the fields under it are written onto
 * the claim by the host that made it, once the launch ended.
 */
export const LAUNCH_CLAIM_FIELDS = {
  generation: {
    type: "integer",
    carried: "always",
    meaning:
      "The attempt the claim makes, from 1: a launch claims the attempt after the latest, and of the claims on one attempt the earliest trusted one wins.",
  },
  pr: {
    type: "integer",
    carried: "always",
    meaning:
      "The number of the pull request the claim is on, always written; a reader that knows which pull request it reads holds the claim to it, and a claim naming another does not read.",
  },
  action: {
    type: "string",
    carried: "always",
    meaning: "What the launch does: one of the actions listed above.",
  },
  record: {
    type: "string",
    carried: "always",
    meaning:
      "The claiming host's launch record, in the dispatcher's form `<yyyymmdd>T<hhmmss>Z-<8 hex>`.",
  },
  host: {
    type: "string",
    carried: "always",
    meaning:
      "The claiming host, as a digest of its dispatcher's database instance: a public comment names no machine, and that host recognises its own claim. Only that host writes the launch's end.",
  },
  facts: {
    type: "string",
    carried: "always",
    meaning:
      "The drive ledger's facts the launch acts on, in words (its generation, its exit, its heartbeat); empty where it acts on none.",
  },
  change: {
    type: "string",
    carried: "sometimes",
    meaning:
      "For a re-drive, the change it acts on (a head, and for a stop on a conflict its base's head), which is re-driven once.",
  },
  earlier: {
    type: "string[]",
    carried: "sometimes",
    meaning:
      "For a re-drive, the changes an earlier launch of the same launch record acted on, which are not re-driven either.",
  },
  owner: {
    type: "boolean",
    carried: "sometimes",
    meaning:
      "Whether the claiming host owns the repository's board, notifications and history rows; absent where that host does not say.",
  },
  conflictStop: {
    type: "boolean",
    carried: "sometimes",
    meaning:
      "Written only as true: the re-drive is of a drive that stopped on a conflict with its base, which a person settles when the re-drive leaves it so.",
  },
  end: {
    type: "object",
    carried: "sometimes",
    meaning:
      "How the launch ended, written onto the claim by the host that made it; absent while it has not ended, as far as that host has written. A claim on the latest attempt with no end holds the pull request's launches for every host.",
  },
  "end.state": {
    type: "string",
    carried: "every end",
    meaning: "How the launch ended: one of the end states listed above.",
  },
  "end.at": {
    type: "string",
    carried: "every end",
    meaning: "When the launch ended, as an ISO 8601 time.",
  },
  "end.exit": {
    type: "integer",
    nullable: true,
    carried: "every ended end",
    meaning:
      "The stage's exit, in the numbering of the drive's exit codes; null when it ended on a signal.",
  },
  "end.outcome": {
    type: "string",
    nullable: true,
    carried: "some ended ends",
    meaning:
      "Null, as a drive's launch writes it. A launch's end has one form for a drive and a follow-up, so a reader also accepts a follow-up's answer here, `done` or `failed`, and an end without the field.",
  },
  "end.by": {
    type: "string",
    carried: "some ended ends",
    meaning:
      "Who wrote the run's closing report (agent, driver, wrapper, steward or person), or none when it left none. The report's own text stays on the host; a value a reader does not know reads as absent.",
  },
  "end.cause": {
    type: "string",
    carried: "some ended ends",
    meaning:
      "Why the run fell short, from the closing report's closed list of causes, when the report named one; a value a reader does not know reads as absent.",
  },
  "end.reason": {
    type: "string",
    carried: "every died end",
    meaning: "Why the launch died, in words.",
  },
  "end.executed": {
    type: "boolean",
    carried: "some died ends",
    meaning:
      "Written only as false, with durable evidence that the launch's reservation never executed; absent otherwise.",
  },
} as const satisfies Readonly<Record<string, ForgeClaimField>>;

/** The merge-ready announcement carries no field beside the envelope's: its key names the head. */
const MERGE_READY_FIELDS = {} as const satisfies Readonly<
  Record<string, ForgeClaimField>
>;

/** Each claim's fields, by its kind's name in the records registry. */
export const FORGE_CLAIM_FIELDS = {
  "drive-takeover-claim": TAKEOVER_CLAIM_FIELDS,
  "dispatch-launch-claim": LAUNCH_CLAIM_FIELDS,
  "drive-merge-ready": MERGE_READY_FIELDS,
} as const satisfies Readonly<
  Record<string, Readonly<Record<string, ForgeClaimField>>>
>;

export type ForgeClaimKindName = keyof typeof FORGE_CLAIM_FIELDS;
