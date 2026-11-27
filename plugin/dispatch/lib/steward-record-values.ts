/**
 * The steward's records (`steward.ts`): the kinds a pass may submit, each
 * kind's fields with their JSON type and what they mean to a reader, the
 * causes a `cause` record may name, and the bounds of a submission and its
 * strings. The reader validates against the shape descriptions beside them
 * (`steward-record-shapes.ts`), which take their kinds, fields, causes and
 * bounds from here; the Jig Protocol's chapter on steward records
 * (`plugin/protocol/steward-records.md`) is generated from both.
 *
 * The closed values a record shares with another contract are that
 * contract's: a need's act (`shared/acts.ts`), and a facet's name and
 * priorities (the tracker facets' `facet-values.ts`).
 *
 * Nothing here imports anything but types, so the chapter's generator reads
 * the tables without loading the dispatcher.
 */
import type {
  CONCLUDED_MAX,
  StewardCause,
} from "../../shared/closing-report.ts";

/** A value of one of the tables, with what it means to a reader that meets it. */
export interface StewardValue {
  readonly meaning: string;
}

/** One field of a steward record. */
export interface StewardField extends StewardValue {
  /** The JSON type of the field's value. */
  readonly type: "string" | "integer or string" | "string[]";
}

/** A record kind: what the tick does with it, and its own fields beside `kind` and `reason`. */
export interface StewardKind extends StewardValue {
  readonly fields: Readonly<Record<string, StewardField>>;
}

/** The fields every record carries, whatever its kind. */
export const STEWARD_COMMON_FIELDS = {
  kind: {
    type: "string",
    meaning:
      "Which of the record kinds it is. A record of a kind not listed, or with a field its kind does not have, is refused with the whole submission.",
  },
  reason: {
    type: "string",
    meaning:
      "Why the steward proposes the record, in its own words. The tick carries it as the reason of what it does: beside a framed need's ask, on a facet's proposal comment, on a re-arm's receipt. It is text a pass wrote after reading untrusted evidence, so a program never acts on it.",
  },
} as const satisfies Readonly<Record<string, StewardField>>;

/** The record kinds a pass may submit, in the order the steward's skill lists them. */
export const STEWARD_RECORD_KINDS = {
  rearm: {
    meaning:
      "Re-arm a stopped drive once, its handoff and logs showing a passing cause. The tick re-arms it only while the drive's facts read as the record's, no person stopped or held it, no registry-class park waits on it, the recovery budget is not spent and no earlier record re-armed the same facts; otherwise it refuses the record.",
    fields: {
      target: {
        type: "string",
        meaning:
          "The stopped drive's pull request, as `PR #<number>`: one of the drives in the pass's digest.",
      },
      facts: {
        type: "string",
        meaning:
          "The drive's facts as the digest gives them (`evidence.stewardFacts`), copied exactly: the tick compares them with the drive's facts when it applies the record.",
      },
      class: {
        type: "string",
        meaning:
          "The recurring cause the steward read, in its own words. Three applied re-arms of one class in a repository within a week propose a reflection finding for a rule that settles it without judgment.",
      },
    },
  },
  resume: {
    meaning:
      "Resume an ended pickup or follow-up pass that stopped on a question outside the repository's human-decision classes and recommended one option. The tick launches it again with one fixed instruction, to take the option it recommended and record it as a decision taken unattended, after checking the account, holds and recovery budget again; no free text reaches the session.",
    fields: {
      record: {
        type: "string",
        meaning:
          "The launch record of the ended pass: one of the passes in the digest.",
      },
    },
  },
  need: {
    meaning:
      "Frame a need that arrived with no framing and stays a person's: the act it asks for and a one-sentence ask. The tick shows them on the need while its cause and question are unchanged; a need that arrived framed is never framed again, and a record for one is refused.",
    fields: {
      target: {
        type: "string",
        meaning:
          "The need's target, as the digest's `needs` name it: only a need with no framing may be named.",
      },
      act: {
        type: "string",
        meaning:
          "What the person is asked to do: one of the closed acts a need names (`NEED_ACTS` in `plugin/shared/acts.ts`). A registry-class park keeps its own act.",
      },
      ask: {
        type: "string",
        meaning: "One sentence asking the person for the act.",
      },
    },
  },
  facet: {
    meaning:
      "Fill a missing priority, type or size of an assigned issue in the queue. The tick posts the proposal and its reason on the issue, reads the issue again, and writes the value only while the facet is still empty and the issue still assigned as the digest read it.",
    fields: {
      target: {
        type: "string",
        meaning: "The issue's key: an assigned issue in the digest's queue.",
      },
      facet: {
        type: "string",
        meaning:
          "Which facet is missing: `priority`, `type` or `size`, the issue facets of the tracker facets chapter.",
      },
      value: {
        type: "integer or string",
        meaning:
          "The value proposed: for a priority, its number from 1 (urgent) to 4 (low); for a type or a size, a canonical value of the repository's label taxonomy and facet configuration, which the tracker checks in the facet's configured store.",
      },
    },
  },
  order: {
    meaning:
      "Order issues of the queue its own rules leave tied: equal on priority, unblocking, epic order, size and the exact creation time. The tick takes the record when every target is wanted and tied, exchanges their places while they stay so, and never moves an issue past one the rules rank apart; otherwise it refuses the record for good with its reason, and the next digest lists the refusal while the targets read as they did.",
    fields: {
      targets: {
        type: "string[]",
        meaning:
          "The tied issues' keys in the order proposed, each in the digest's queue and none twice.",
      },
    },
  },
  cause: {
    meaning:
      "Say why a pickup's or a follow-up's run that ended without a closing report fell short, read from the excerpt of its transcript. The tick records it as the run's closing report, written by the steward, only while the run holds none; otherwise it refuses the record.",
    fields: {
      record: {
        type: "string",
        meaning:
          "The launch record of the run: one of the runs the digest lists as ended without a report (`unreported`).",
      },
      cause: {
        type: "string",
        meaning: "Why the run fell short: one of the causes listed below.",
      },
      summary: {
        type: "string",
        meaning:
          "What the run had done and where it stopped, with no secret, personal data or quoted output; it becomes the closing report's `concluded`.",
      },
    },
  },
} as const satisfies Readonly<Record<string, StewardKind>>;

export type StewardKindName = keyof typeof STEWARD_RECORD_KINDS;

/**
 * The causes a `cause` record names: the closing report's causes a
 * transcript can show (`STEWARD_CAUSES`), each with what it means. What the
 * wrapper or the driver observed (a deadline, a start that failed, a usage
 * limit) is theirs to record.
 */
export const STEWARD_CAUSE_VALUES = {
  "needs-person": {
    meaning:
      "The run reached something only a person can decide or do, and stopped there.",
  },
  refused: {
    meaning:
      "The run declined the work, or was refused a step it needed by a rule, a permission or a policy.",
  },
  "tool-failed": {
    meaning:
      "A tool the run depended on (a command, a script, a service) failed, and the run could not go on.",
  },
  environment: {
    meaning:
      "The host or the checkout kept the run from working: a missing dependency or credential, a broken tree, a full disk.",
  },
  scope: {
    meaning:
      "The work was larger than, or other than, what the item described, and the run stopped rather than widen it.",
  },
  crashed: {
    meaning: "The transcript stops mid-work with no error that explains it.",
  },
  unknown: {
    meaning:
      "The excerpt does not show why the run fell short, or there is no excerpt.",
  },
} as const satisfies Readonly<Record<StewardCause, StewardValue>>;

/** A bound of a submission or of its records' strings. */
export interface StewardLimit extends StewardValue {
  readonly value: number;
}

/**
 * The bounds the reader holds a submission to. A string is also never empty
 * or only white space. A string bound by `text` or `facet-value` is counted
 * in UTF-16 code units, as JavaScript counts a string's length, and a
 * summary in characters.
 */
export const STEWARD_RECORD_LIMITS = {
  records: {
    value: 100,
    meaning: "The most records one submission holds.",
  },
  targets: {
    value: 100,
    meaning: "The most issue keys one `order` record names.",
  },
  text: {
    value: 4000,
    meaning:
      "The longest string a record carries, in UTF-16 code units: its reason, and each field other than the bounds below.",
  },
  "facet-value": {
    value: 100,
    meaning:
      "The longest type or size a `facet` record proposes, in UTF-16 code units.",
  },
  summary: {
    value: 600 satisfies typeof CONCLUDED_MAX,
    meaning:
      "The longest summary a `cause` record carries, in characters: the closing report's bound on what a run concluded.",
  },
} as const satisfies Readonly<Record<string, StewardLimit>>;
