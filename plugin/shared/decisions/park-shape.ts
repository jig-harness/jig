/**
 * The shape of a decision record (`parked-decision/v1`) as its stored
 * readers accept it: the fields of `decision-values.ts`'s
 * `PARKED_DECISION_FIELDS`, each of its JSON type, and fields added later
 * tolerated at every level. `isParkedDecision` (`park.ts`) reads a kept
 * decision through it, and the Jig Protocol's chapter on needs and
 * structured answers publishes its schema from the same description.
 *
 * What a shape cannot say stays with the strict check a writer passes
 * (`checkParkedDecision`), which takes its field lists from here: that no
 * text is empty, the question is one line ending with `?`, the recommended
 * option is one the call offers, option ids are short and unique and option
 * names stay distinct once normalized, and that no other field is present.
 * A stored record's text may be redacted, so its reader checks none of that.
 */
import { type Shape, s } from "../shapes.ts";
import { PARKED_DECISION_SCHEMA } from "./decision-values.ts";

const text = s.string();
const texts = s.array(text);

/** An option's fields, required ones first, in the order the strict check names them. */
export const PARKED_OPTION_FIELDS = {
  id: text,
  name: text,
  summary: text,
  pay: texts,
  tag: s.optional(text),
  keep: s.optional(texts),
  rightWhen: s.optional(text),
  obligation: s.optional(text),
  reversible: s.optional(s.boolean()),
};
const PARKED_OPTION_SHAPE = s.object(PARKED_OPTION_FIELDS);

/** The call's fields: the question, its options and the recommended one. */
export const PARKED_CALL_FIELDS = {
  id: text,
  question: text,
  options: s.array(PARKED_OPTION_SHAPE),
  recommended: text,
  why: text,
};
const PARKED_CALL_SHAPE = s.object(PARKED_CALL_FIELDS);

/** A fact the decision rests on, with where it was found. */
const PARKED_FACT_FIELDS = { text, source: text };
/** How the decision bears on something else. */
export const PARKED_INTERPLAY_FIELDS = { from: text, to: text, text };

/** The record's own fields, required ones first, in the order the strict check names them. */
export const PARKED_DECISION_FIELD_SHAPES = {
  schema: s.literal(PARKED_DECISION_SCHEMA),
  class: text,
  call: PARKED_CALL_SHAPE,
  steps: texts,
  alreadyDone: text,
  facts: s.optional(s.array(s.object(PARKED_FACT_FIELDS))),
  interplay: s.optional(s.array(s.object(PARKED_INTERPLAY_FIELDS))),
  sheet: s.optional(text),
};

/** A decision waiting for a person, as a stored reader accepts it. */
export const PARKED_DECISION_SHAPE = s.object(PARKED_DECISION_FIELD_SHAPES);

/** An object shape's required fields and its optional ones, each in the order it declares them. */
export function fieldLists(
  fields: Readonly<Record<string, Shape>>,
): [required: string[], optional: string[]] {
  const entries = Object.entries(fields);
  return [
    entries.filter(([, f]) => f.optional !== true).map(([key]) => key),
    entries.filter(([, f]) => f.optional === true).map(([key]) => key),
  ];
}
