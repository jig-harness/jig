/**
 * The shapes of the steward's records, one per kind, and of a submission.
 * The reader (`checkedRecords` in `steward.ts`), which checks both a pass's
 * submission and each kept record before the tick applies it, accepts a
 * record only when it fits its kind's shape here, and the Jig Protocol's
 * chapter on steward records publishes each shape's schema from the same
 * description. Kinds, fields, causes and bounds come from the tables
 * (`steward-record-values.ts`); a need's acts from `shared/acts.ts`, and the
 * priorities from the tracker facets' table.
 *
 * What a shape cannot say stays with the reader: that an order names no
 * issue twice. A string's bound in UTF-16 code units is a pattern, which
 * Jig's validator reads without Unicode mode; a validator that reads it in
 * Unicode mode counts characters, as `maxLength` does, and so accepts some
 * strings of characters outside the Basic Multilingual Plane the reader
 * refuses.
 */
import { NEED_ACTS } from "../../shared/acts.ts";
import { type Infer, s, type Shape } from "../../shared/shapes.ts";
import {
  FACET_TABLE,
  PRIORITIES,
} from "../../skills/do-item/scripts/lib/tracker/facets/facet-values.ts";
import {
  STEWARD_CAUSE_VALUES,
  STEWARD_RECORD_LIMITS,
  type StewardKindName,
} from "./steward-record-values.ts";

type Cause = keyof typeof STEWARD_CAUSE_VALUES;

const TEXT_MAX = STEWARD_RECORD_LIMITS.text.value;

/** A string with some character other than white space, at most `max` UTF-16 code units long. */
function text(max: number) {
  return s.string({
    pattern: `^(?=[\\s\\S]*\\S)[\\s\\S]{1,${max}}$`,
    maxLength: max,
  });
}

/** Every string a record carries, its reason among them. */
const STEWARD_TEXT_SHAPE = text(TEXT_MAX);

/** A drive's pull request as a re-arm names it, `PR #<number>`, within the string bound. */
const PR_TARGET_SHAPE = s.string({
  pattern: `^PR #[1-9]\\d{0,${TEXT_MAX - "PR #1".length}}$`,
  maxLength: TEXT_MAX,
});

/** A record's own fields, closed: `kind`, `reason` and its kind's fields, every one required. */
const record = <
  const K extends StewardKindName,
  const P extends Record<string, Shape>,
>(
  kind: K,
  fields: P,
) =>
  s.object(
    { kind: s.literal(kind), ...fields, reason: STEWARD_TEXT_SHAPE },
    { additionalProperties: false },
  );

/** The facets a record may fill with a value of the repository's own, every facet but the priority. */
const NAMED_FACETS = (
  Object.keys(FACET_TABLE) as (keyof typeof FACET_TABLE)[]
).filter(
  (facet): facet is Exclude<typeof facet, "priority"> => facet !== "priority",
);

/** Each kind's shape, by its name. */
export const STEWARD_RECORD_SHAPES = {
  rearm: record("rearm", {
    target: PR_TARGET_SHAPE,
    facts: STEWARD_TEXT_SHAPE,
    class: STEWARD_TEXT_SHAPE,
  }),
  resume: record("resume", { record: STEWARD_TEXT_SHAPE }),
  need: record("need", {
    target: STEWARD_TEXT_SHAPE,
    act: s.enum(NEED_ACTS),
    ask: STEWARD_TEXT_SHAPE,
  }),
  facet: s.union([
    record("facet", {
      target: STEWARD_TEXT_SHAPE,
      facet: s.literal("priority"),
      value: s.enum(Object.values(PRIORITIES).map((p) => p.number)),
    }),
    record("facet", {
      target: STEWARD_TEXT_SHAPE,
      facet: s.enum(NAMED_FACETS),
      value: text(STEWARD_RECORD_LIMITS["facet-value"].value),
    }),
  ]),
  order: record("order", {
    targets: s.array(STEWARD_TEXT_SHAPE, {
      maxItems: STEWARD_RECORD_LIMITS.targets.value,
    }),
  }),
  cause: record("cause", {
    record: STEWARD_TEXT_SHAPE,
    cause: s.enum(Object.keys(STEWARD_CAUSE_VALUES) as Cause[]),
    // Counted in characters; a summary within it is within the string bound too.
    summary: s.string({
      pattern: "\\S",
      maxLength: STEWARD_RECORD_LIMITS.summary.value,
    }),
  }),
} as const satisfies Readonly<Record<StewardKindName, Shape>>;

/** A record of any kind. */
export const STEWARD_RECORD_SHAPE = s.union(
  Object.values(STEWARD_RECORD_SHAPES),
);

export type StewardRecord = Infer<typeof STEWARD_RECORD_SHAPE>;

/** A record's reason, which the reader checks before the rest of the record. */
export const STEWARD_REASONED_SHAPE = s.object({ reason: STEWARD_TEXT_SHAPE });

/** A pass's submission as its JSON file holds it: a list of records. */
export const STEWARD_SUBMISSION_SHAPE = s.array(STEWARD_RECORD_SHAPE, {
  maxItems: STEWARD_RECORD_LIMITS.records.value,
});

/** A submission's list, before its records are read one by one. */
export const STEWARD_LIST_SHAPE = s.array(s.unknown(), {
  maxItems: STEWARD_RECORD_LIMITS.records.value,
});
