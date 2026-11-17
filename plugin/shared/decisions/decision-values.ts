/**
 * The values of a decision waiting for a person and of the answers to it:
 * the fields of the decision record (`parked-decision/v1`), the two forms a
 * structured answer takes, the two lines an answer is written in, and the
 * limits the readers hold an answer and a decision to. Each entry says what
 * it means to a reader that meets it.
 *
 * The decision record's shape (`park-shape.ts`) declares the same fields,
 * held equal to this table by its test, the answer readers and writers
 * (`decision-card.ts`, `answer-text.ts`, `answer-digest.ts`) their words
 * and limits, and the Jig Protocol's chapter on needs and structured answers
 * (`plugin/protocol/needs-and-answers.md`) is generated from these tables.
 *
 * Nothing here imports anything, so the dashboard's page bundles it and the
 * chapter's generator reads it without loading the drive or the dispatcher.
 */

/** The value of a decision record's `schema` field: the record's form and version. */
export const PARKED_DECISION_SCHEMA = "parked-decision/v1";

/** A value of one of the tables, with what it means to a reader that meets it. */
export interface DecisionValue {
  readonly meaning: string;
}

/** One field of the decision record, at its path in the record. */
export interface DecisionField extends DecisionValue {
  /** The JSON type of the field's value. */
  readonly type: "string" | "boolean" | "object" | "string[]" | "object[]";
  /** Whether every record carries it (`always`) or only some (`sometimes`). */
  readonly carried: "always" | "sometimes";
}

/**
 * The fields of the decision record, each at its path: a field of the call
 * under `call.`, a field of each option under `call.options[].`, a field of
 * each fact under `facts[].`, and a field of each interplay entry under
 * `interplay[].`. A reader tolerates fields this table does not list, and
 * the strict check a writer passes refuses them.
 */
export const PARKED_DECISION_FIELDS = {
  schema: {
    type: "string",
    carried: "always",
    meaning: `Always \`${PARKED_DECISION_SCHEMA}\`: a reader that meets another value does not read the record as a decision.`,
  },
  class: {
    type: "string",
    carried: "always",
    meaning:
      "The decision class the decision falls in: a class of the repository's human-in-the-loop registry, or one of the dispatcher's own framings. Its act is in the classes table below; a class that table does not list asks a person to decide.",
  },
  call: {
    type: "object",
    carried: "always",
    meaning: "The question, its options and the recommended option.",
  },
  "call.id": {
    type: "string",
    carried: "always",
    meaning: "The call's id: one to eight letters or digits.",
  },
  "call.question": {
    type: "string",
    carried: "always",
    meaning: "The question a person answers: one line, ending with `?`.",
  },
  "call.options": {
    type: "object[]",
    carried: "always",
    meaning:
      "The options a person chooses from, at least two, in the order the decision gives them. A refusal or a wait is an option of its own.",
  },
  "call.options[].id": {
    type: "string",
    carried: "always",
    meaning:
      "The option's id, one to eight letters or digits, unique within the call: `call.recommended` names an option by it.",
  },
  "call.options[].name": {
    type: "string",
    carried: "always",
    meaning:
      "The option's name on one line: what `choose <option>` names. No two options' names are the same once normalized, so a `choose` never names two options.",
  },
  "call.options[].summary": {
    type: "string",
    carried: "always",
    meaning: "What choosing the option changes.",
  },
  "call.options[].pay": {
    type: "string[]",
    carried: "always",
    meaning: "What choosing the option costs, at least one entry.",
  },
  "call.options[].tag": {
    type: "string",
    carried: "sometimes",
    meaning: "A short label shown with the option.",
  },
  "call.options[].keep": {
    type: "string[]",
    carried: "sometimes",
    meaning: "What the option keeps as it is.",
  },
  "call.options[].rightWhen": {
    type: "string",
    carried: "sometimes",
    meaning: "When the option is the right one.",
  },
  "call.options[].obligation": {
    type: "string",
    carried: "sometimes",
    meaning: "What choosing the option obliges someone to do afterwards.",
  },
  "call.options[].reversible": {
    type: "boolean",
    carried: "sometimes",
    meaning:
      "Whether what the option does can be undone. A card asks for a second step before it commits a pick of an option marked `false`.",
  },
  "call.recommended": {
    type: "string",
    carried: "always",
    meaning:
      "The id of the option the decision recommends: the option `approve` chooses.",
  },
  "call.why": {
    type: "string",
    carried: "always",
    meaning: "Why the decision recommends that option.",
  },
  steps: {
    type: "string[]",
    carried: "always",
    meaning:
      "What a person must do by hand whichever option is chosen; empty when there is nothing.",
  },
  alreadyDone: {
    type: "string",
    carried: "always",
    meaning: "What the session that framed the decision already did about it.",
  },
  facts: {
    type: "object[]",
    carried: "sometimes",
    meaning: "Facts the decision rests on, each with where it was found.",
  },
  "facts[].text": {
    type: "string",
    carried: "always",
    meaning: "The fact.",
  },
  "facts[].source": {
    type: "string",
    carried: "always",
    meaning: "Where the fact was found: a file and line, a link, a command.",
  },
  interplay: {
    type: "object[]",
    carried: "sometimes",
    meaning:
      "How this decision bears on others, entry by entry: what settling one means for another.",
  },
  "interplay[].from": {
    type: "string",
    carried: "always",
    meaning:
      "What the entry starts from, in free text: a call's id, another decision, an issue or a decision record.",
  },
  "interplay[].to": {
    type: "string",
    carried: "always",
    meaning: "What the entry bears on, in the same free text as `from`.",
  },
  "interplay[].text": {
    type: "string",
    carried: "always",
    meaning: "How the one shrinks or sharpens the other.",
  },
  sheet: {
    type: "string",
    carried: "sometimes",
    meaning:
      "The address of a decision sheet that sets the decision out at length: an https URL.",
  },
} as const satisfies Readonly<Record<string, DecisionField>>;

/** A form of a structured answer, as a person writes it. */
export interface AnswerFormValue extends DecisionValue {
  readonly written: string;
}

/**
 * The forms of a structured answer. An answer's text, its trailing digest
 * taken off and normalized, that is exactly one of them chooses an option;
 * any other text is a free answer, which the session that reads it
 * interprets in the person's own words.
 */
export const ANSWER_FORMS = {
  approve: {
    written: "approve",
    meaning:
      "Chooses the option the decision recommends. On a decision that recommends no option it is a free answer.",
  },
  choose: {
    written: "choose <option>",
    meaning:
      "Chooses the option whose normalized name is `<option>`. A name no option of the decision has makes it a free answer.",
  },
} as const satisfies Readonly<Record<string, AnswerFormValue>>;

/** A structured answer's form: `approve` or `choose`. */
export type AnswerForm = keyof typeof ANSWER_FORMS;

/** The forms, in the table's order. */
export const ANSWER_FORM_NAMES = Object.keys(ANSWER_FORMS) as AnswerForm[];

/**
 * The lines an answer is written in, each on a line of its own in a comment
 * on the pull request or the item. In a reply on the item's review thread,
 * the reply's one line may be the answer's text alone.
 */
export const ANSWER_LINES = {
  answer: {
    written: "answer <key>: <text>",
    meaning:
      "Answers the decision parked under `<key>` with `<text>`: a structured answer when the comment holds nothing but answer and note lines (and blank lines, `jig send`'s record and quotes of the notification), and the text is one of the forms; otherwise a free answer.",
  },
  note: {
    written: "note <key>: <text>",
    meaning:
      "Adds the person's own words to the structured answer to `<key>` beside it, which may narrow the option chosen or set a condition on it, never widen it. A note with no answer beside it answers nothing.",
  },
} as const satisfies Readonly<Record<string, AnswerFormValue>>;

/** An answer line's opening word. */
export type AnswerLineWord = keyof typeof ANSWER_LINES;

/** A limit the readers hold a decision or an answer to. */
export interface DecisionLimit extends DecisionValue {
  readonly value: number;
  readonly unit: string;
}

/** The limits on a decision and its answers. */
export const DECISION_LIMITS = {
  "answer-text": {
    value: 500,
    unit: "characters",
    meaning:
      "The longest an answer's or a note's text may be. A longer one, or one with a line break, another control character or a hidden marker (`<!--`), is not a structured answer, and `jig send` refuses to send it.",
  },
  digest: {
    value: 12,
    unit: "hexadecimal characters",
    meaning:
      "The length of a decision digest: the first characters of the SHA-256 of the decision record as stored, in canonical JSON, kept with the decision. An answer ends with its framing's digest in square brackets, `approve [3fa9c2d1e0b4]`; an answer naming another digest is stale and settles nothing, and one naming none is bound by its time alone.",
  },
  "decision-bytes": {
    value: 8192,
    unit: "bytes",
    meaning:
      "The largest a decision record may be, as UTF-8 JSON. A park, a dispatched session's result and its closing report refuse a larger one.",
  },
} as const satisfies Readonly<Record<string, DecisionLimit>>;
