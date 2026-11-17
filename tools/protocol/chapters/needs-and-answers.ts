/**
 * The chapter on needs and structured answers, generated from the tables of
 * a decision waiting for a person and of the answers to it: the decision
 * record's fields, the answer forms and lines, the limits
 * (`shared/decisions/decision-values.ts`) and the normalization an answer
 * goes through (`answer-normalize.ts`); the acts a need asks for and the act
 * of each decision class Jig knows (`shared/acts.ts`); and the dispatcher's
 * own framings, each kind of need's key and the options the tick carries
 * out (`shared/decisions/station.ts`).
 *
 * The decision record's schema is published from the shape its stored
 * reader validates against (`park-shape.ts`). The causes the dispatcher
 * finds waiting on a person, and the act each asks for (`CAUSE_ACTS`), are
 * left to plan item 50, which is still settling them.
 */
import { CLASS_ACTS, NEED_ACT_VALUES } from "../../../plugin/shared/acts.ts";
import { ANSWER_NORMALIZATION } from "../../../plugin/shared/decisions/answer-normalize.ts";
import {
  ANSWER_FORMS,
  ANSWER_LINES,
  DECISION_LIMITS,
  type DecisionField,
  PARKED_DECISION_FIELDS,
} from "../../../plugin/shared/decisions/decision-values.ts";
import { PARKED_DECISION_SHAPE } from "../../../plugin/shared/decisions/park-shape.ts";
import {
  STATION_KEYS,
  STATION_OPTIONS,
} from "../../../plugin/shared/decisions/station.ts";
import type { Chapter, DataValue, FieldSpec } from "../chapter.ts";
import { checkHeldPhrases } from "../held.ts";
import { table } from "../markdown.ts";

const VALUES = "plugin/shared/decisions/decision-values.ts";
const NORMALIZE = "plugin/shared/decisions/answer-normalize.ts";
const ACTS = "plugin/shared/acts.ts";
const STATION = "plugin/shared/decisions/station.ts";

/** Entries of the imported tables this chapter leaves out: none. */
const EXCLUDED: readonly string[] = [];

const ticked = (text: string) => `\`${text}\``;

/** Every value's fields, each null where the value's kind has none. */
const NONE = {
  type: null,
  carried: null,
  written: null,
  step: null,
  value: null,
  unit: null,
  act: null,
  class: null,
  options: null,
  option: null,
  reversible: null,
} as const;

interface Row {
  readonly entry: string;
  readonly value: DataValue;
}

function rows(): Row[] {
  const fields = Object.entries(
    PARKED_DECISION_FIELDS as Readonly<Record<string, DecisionField>>,
  ).map(([name, f]) => ({
    entry: `${VALUES}#PARKED_DECISION_FIELDS.${name}`,
    value: {
      kind: "field",
      name,
      ...NONE,
      type: f.type,
      carried: f.carried,
      meaning: f.meaning,
    },
  }));
  const forms = Object.entries(ANSWER_FORMS).map(([name, f]) => ({
    entry: `${VALUES}#ANSWER_FORMS.${name}`,
    value: {
      kind: "form",
      name,
      ...NONE,
      written: f.written,
      meaning: f.meaning,
    },
  }));
  const lines = Object.entries(ANSWER_LINES).map(([name, l]) => ({
    entry: `${VALUES}#ANSWER_LINES.${name}`,
    value: {
      kind: "line",
      name,
      ...NONE,
      written: l.written,
      meaning: l.meaning,
    },
  }));
  const steps = Object.entries(ANSWER_NORMALIZATION).map(([name, n], i) => ({
    entry: `${NORMALIZE}#ANSWER_NORMALIZATION.${name}`,
    value: {
      kind: "normalization",
      name,
      ...NONE,
      step: i + 1,
      meaning: n.meaning,
    },
  }));
  const limits = Object.entries(DECISION_LIMITS).map(([name, l]) => ({
    entry: `${VALUES}#DECISION_LIMITS.${name}`,
    value: {
      kind: "limit",
      name,
      ...NONE,
      value: l.value,
      unit: l.unit,
      meaning: l.meaning,
    },
  }));
  const acts = Object.entries(NEED_ACT_VALUES).map(([name, a]) => ({
    entry: `${ACTS}#NEED_ACT_VALUES.${name}`,
    value: { kind: "act", name, ...NONE, meaning: a.meaning },
  }));
  const classes = Object.entries(CLASS_ACTS).map(([name, c]) => ({
    entry: `${ACTS}#CLASS_ACTS.${name}`,
    value: { kind: "class", name, ...NONE, act: c.act, meaning: c.meaning },
  }));
  const keys = Object.entries(STATION_KEYS).map(([name, k]) => ({
    entry: `${STATION}#STATION_KEYS.${name}`,
    value: {
      kind: "station-key",
      name,
      ...NONE,
      class: k.class,
      options: k.options.join(", "),
      meaning: k.meaning,
    },
  }));
  const options = Object.entries(STATION_OPTIONS).map(([name, o]) => ({
    entry: `${STATION}#STATION_OPTIONS.${name}`,
    value: {
      kind: "station-option",
      name,
      ...NONE,
      option: o.name,
      reversible: o.reversible ?? null,
      meaning: o.summary,
    },
  }));
  return [
    ...fields,
    ...forms,
    ...lines,
    ...steps,
    ...limits,
    ...acts,
    ...classes,
    ...keys,
    ...options,
  ].filter((r) => !EXCLUDED.includes(r.entry));
}

const of = (kind: string) =>
  rows()
    .map((r) => r.value)
    .filter((v) => v.kind === kind);

const text = (v: DataValue, field: string) => String(v[field]);

function fieldsTable(): string {
  return table(
    ["Field", "Type", "Carried", "Meaning"],
    of("field").map((v) => [
      ticked(text(v, "name")),
      text(v, "type"),
      text(v, "carried"),
      text(v, "meaning"),
    ]),
  );
}

function writtenTable(kind: string, heading: string): () => string {
  return () =>
    table(
      [heading, "Written", "Meaning"],
      of(kind).map((v) => [
        ticked(text(v, "name")),
        ticked(text(v, "written")),
        text(v, "meaning"),
      ]),
    );
}

function normalizationTable(): string {
  return table(
    ["Step", "Name", "Meaning"],
    of("normalization").map((v) => [
      text(v, "step"),
      ticked(text(v, "name")),
      text(v, "meaning"),
    ]),
  );
}

function limitsTable(): string {
  return table(
    ["Limit", "Value", "Unit", "Meaning"],
    of("limit").map((v) => [
      ticked(text(v, "name")),
      text(v, "value"),
      text(v, "unit"),
      text(v, "meaning"),
    ]),
  );
}

function actsTable(): string {
  return table(
    ["Act", "Meaning"],
    of("act").map((v) => [ticked(text(v, "name")), text(v, "meaning")]),
  );
}

function classesTable(): string {
  return table(
    ["Class", "Act", "Meaning"],
    of("class").map((v) => [
      ticked(text(v, "name")),
      ticked(text(v, "act")),
      text(v, "meaning"),
    ]),
  );
}

function keysTable(): string {
  return table(
    ["Key", "Class", "Options", "Meaning"],
    of("station-key").map((v) => [
      ticked(text(v, "name")),
      ticked(text(v, "class")),
      text(v, "options").split(", ").map(ticked).join(", "),
      text(v, "meaning"),
    ]),
  );
}

function optionsTable(): string {
  return table(
    ["Option", "Name", "Can be undone", "Meaning"],
    of("station-option").map((v) => [
      ticked(text(v, "name")),
      `**${text(v, "option")}**`,
      v.reversible === null ? "—" : v.reversible ? "yes" : "no",
      text(v, "meaning"),
    ]),
  );
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "field for a field of the decision record, form for a form of a structured answer, line for a line an answer is written in, normalization for a step of normalizing an answer, limit for a limit on a decision or an answer, act for what a need asks a person to do, class for a decision class Jig knows, station-key for a kind of need the dispatcher frames, and station-option for an option the dispatcher carries out.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "A field's path in the record (a field of each option as call.options[].<field>), a form's or a line's opening word, a step's or a limit's name, an act or a class as a record names it, the key an answer to a dispatcher's framing names, or an option's id.",
  },
  type: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a field, the JSON type of its value (string, boolean, object, string[] or object[] for a list of strings or objects); null otherwise.",
  },
  carried: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a field, always when every record (or every entry of the list it is in) carries it, sometimes when only some do; null otherwise.",
  },
  written: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a form or a line, how a person writes it, its parts in angle brackets; null otherwise.",
  },
  step: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a normalization step, its place in the order the steps apply, from 1; null otherwise.",
  },
  value: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description: "For a limit, its value in its unit; null otherwise.",
  },
  unit: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description: "For a limit, what its value counts; null otherwise.",
  },
  act: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a class, the act a decision under it asks for; null otherwise.",
  },
  class: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a station key, the class of the decision the dispatcher frames for it; null otherwise.",
  },
  options: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a station key, the ids of the options its decision offers, in their order, each separated from the next by a comma and a space; null otherwise.",
  },
  option: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a station option, its name as the decision gives it and `choose` names it; null otherwise.",
  },
  reversible: {
    type: "boolean",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a station option, true when the decision marks what it does as one that can be undone; null when the decision does not say, and for every other value.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "What the value means to a reader that meets it; for a station option, what choosing it does, as the decision's summary says.",
  },
};

const ANSWER = ANSWER_LINES.answer.written.split(" ")[0];
const NOTE = ANSWER_LINES.note.written;

/**
 * The drive's procedure acts on the answer forms within a step, so it keeps
 * them; the plugin's reference keeps the keys and the first option of each
 * dispatcher framing in its table of what the tick does.
 */
function held(root: string) {
  const firstOption = (key: keyof typeof STATION_KEYS) => {
    const id = STATION_KEYS[key].options[0];
    return id === undefined ? "" : STATION_OPTIONS[id].name;
  };
  return checkHeldPhrases(root, "needs-and-answers", [
    {
      file: "plugin/skills/drive-pr/SKILL.md",
      text: `\`${ANSWER} <key>: ${ANSWER_FORMS.approve.written}\` for the recommended option`,
    },
    {
      file: "plugin/skills/drive-pr/SKILL.md",
      text: `\`${ANSWER} <key>: ${ANSWER_FORMS.choose.written}\` for another option`,
    },
    {
      file: "plugin/skills/drive-pr/SKILL.md",
      text: `\`${NOTE}\` may add a condition of at most ${DECISION_LIMITS["answer-text"].value} characters`,
    },
    {
      file: "plugin/skills/drive-pr/SKILL.md",
      text: `the first ${DECISION_LIMITS.digest.value} hexadecimal characters of its canonical decision's SHA-256`,
    },
    ...(Object.keys(STATION_KEYS) as (keyof typeof STATION_KEYS)[]).map(
      (key) => ({
        file: "plugin/README.md",
        text: `| \`${key}\` | **${firstOption(key)}**:`,
      }),
    ),
    {
      file: "plugin/README.md",
      text: `each set ending with **${STATION_OPTIONS.hold.name}**`,
    },
  ]);
}

export const NEEDS_AND_ANSWERS: Chapter = {
  id: "needs-and-answers",
  title: "Needs and structured answers",
  summary:
    "A decision waiting for a person and the answers to it: the decision record's fields, the forms and lines of a structured answer and how it is normalized, the acts a need asks for, and the dispatcher's own framings with the options it carries out.",
  version: 1,
  status: "provisional",
  planItems: [
    { item: 46, epic: 693 },
    { item: 50, epic: 940 },
  ],
  module: "tools/protocol/chapters/needs-and-answers.ts",
  sections: [
    { source: `${VALUES}#PARKED_DECISION_FIELDS`, render: fieldsTable },
    { source: `${VALUES}#ANSWER_LINES`, render: writtenTable("line", "Line") },
    { source: `${VALUES}#ANSWER_FORMS`, render: writtenTable("form", "Form") },
    { source: `${NORMALIZE}#ANSWER_NORMALIZATION`, render: normalizationTable },
    { source: `${VALUES}#DECISION_LIMITS`, render: limitsTable },
    { source: `${ACTS}#NEED_ACT_VALUES`, render: actsTable },
    { source: `${ACTS}#CLASS_ACTS`, render: classesTable },
    { source: `${STATION}#STATION_KEYS`, render: keysTable },
    { source: `${STATION}#STATION_OPTIONS`, render: optionsTable },
  ],
  fields: FIELDS,
  values: () => rows().map((r) => r.value),
  takes: () => rows().map((r) => r.entry),
  excluded: EXCLUDED,
  check: held,
  schemas: [{ name: "parked-decision", shape: PARKED_DECISION_SHAPE }],
};
