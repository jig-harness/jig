/**
 * The chapter on steward records: the closed records a steward pass submits
 * for the dispatcher's next tick, generated from their kind in the records
 * registry and from their tables (`STEWARD_RECORD_KINDS`,
 * `STEWARD_COMMON_FIELDS`, `STEWARD_CAUSE_VALUES`, `STEWARD_RECORD_LIMITS`).
 *
 * Its values are the registry's kind, each record kind, each kind's fields,
 * the causes a `cause` record names and the bounds the reader holds; each
 * record kind's schema, and a submission's, are published from the shapes
 * the reader validates against (`steward-record-shapes.ts`). A need's acts
 * and a facet's names and priorities are other chapters' values, and the
 * kinds the steward's remit is planned to widen with are not built.
 */
import { Defect } from "../../../plugin/shared/errors.ts";
import {
  type RecordKind,
  recordKind,
} from "../../../plugin/shared/records/registry.ts";
import {
  STEWARD_RECORD_SHAPES,
  STEWARD_SUBMISSION_SHAPE,
} from "../../../plugin/dispatch/lib/steward-record-shapes.ts";
import {
  STEWARD_CAUSE_VALUES,
  STEWARD_COMMON_FIELDS,
  STEWARD_RECORD_KINDS,
  STEWARD_RECORD_LIMITS,
  type StewardField,
  type StewardKindName,
} from "../../../plugin/dispatch/lib/steward-record-values.ts";
import type { Chapter, DataValue, FieldSpec } from "../chapter.ts";
import { checkHeldPhrases, type HeldPhrase } from "../held.ts";
import { table } from "../markdown.ts";
import { recordKindsTable } from "../record-kinds.ts";

const REGISTRY = "plugin/shared/records/registry.ts";
const VALUES = "plugin/dispatch/lib/steward-record-values.ts";

/** The registry's kind the steward's records are kept as. */
const KEPT = "dispatch-steward-record";

/** What the fields table names for a field every kind carries. */
const EVERY = "every kind";

const ticked = (text: string) => `\`${text}\``;

function keptKind(): RecordKind {
  const kind = recordKind(KEPT);
  if (kind === undefined)
    throw new Defect(`the records registry holds no ${KEPT}`);
  return kind;
}

const kinds = () =>
  (Object.keys(STEWARD_RECORD_KINDS) as StewardKindName[]).map((name) => ({
    name,
    meaning: STEWARD_RECORD_KINDS[name].meaning,
  }));

/** One field of a record, with the kind it belongs to, or none for every kind's. */
interface FieldRow extends StewardField {
  readonly kind: StewardKindName | null;
  readonly name: string;
  readonly table: "STEWARD_COMMON_FIELDS" | "STEWARD_RECORD_KINDS";
}

/** The fields every kind carries, then each kind's own, in the kinds' order. */
const fields = (): FieldRow[] => [
  ...Object.entries(STEWARD_COMMON_FIELDS).map(([name, f]) => ({
    kind: null,
    name,
    table: "STEWARD_COMMON_FIELDS" as const,
    ...f,
  })),
  ...kinds().flatMap(({ name: kind }) =>
    Object.entries(
      STEWARD_RECORD_KINDS[kind].fields as Readonly<
        Record<string, StewardField>
      >,
    ).map(([name, f]) => ({
      kind,
      name,
      table: "STEWARD_RECORD_KINDS" as const,
      ...f,
    })),
  ),
];

const causes = () =>
  Object.entries(STEWARD_CAUSE_VALUES).map(([name, v]) => ({
    name,
    meaning: v.meaning,
  }));

const limits = () =>
  Object.entries(STEWARD_RECORD_LIMITS).map(([name, v]) => ({
    name,
    value: v.value,
    meaning: v.meaning,
  }));

/** Where a field's entry is in its table: a kind's own under its `fields`. */
const fieldEntry = (f: FieldRow) =>
  f.kind === null
    ? `${VALUES}#${f.table}.${f.name}`
    : `${VALUES}#${f.table}.${f.kind}.fields.${f.name}`;

function kindsTable(): string {
  return table(
    ["Kind", "Meaning"],
    kinds().map((k) => [ticked(k.name), k.meaning]),
  );
}

function fieldsTable(): string {
  return table(
    ["Kind", "Field", "Type", "Meaning"],
    fields().map((f) => [
      f.kind === null ? EVERY : ticked(f.kind),
      ticked(f.name),
      f.type,
      f.meaning,
    ]),
  );
}

function causesTable(): string {
  return table(
    ["Cause", "Meaning"],
    causes().map((c) => [ticked(c.name), c.meaning]),
  );
}

function limitsTable(): string {
  return table(
    ["Bound", "Value", "Meaning"],
    limits().map((l) => [ticked(l.name), String(l.value), l.meaning]),
  );
}

/** The steward's skill, whose decision step restates the kinds, fields, causes and bounds it writes. */
const SKILL = "plugin/skills/steward/SKILL.md";
const DECIDE = "## Decide what the next tick should do";

/** `a`, `b` or `c`. */
const either = (names: readonly string[]) =>
  names.length < 2
    ? names.map(ticked).join("")
    : `${names.slice(0, -1).map(ticked).join(", ")} or ${ticked(names.at(-1) ?? "")}`;

/** The phrases the skill's decision step acts on, each carrying values from the tables. */
export function heldPhrases(): HeldPhrase[] {
  const held = (text: string): HeldPhrase => ({
    file: SKILL,
    text,
    section: DECIDE,
  });
  return [
    ...kinds().map(({ name }) =>
      held(
        `| ${ticked(name)} | ${Object.keys(STEWARD_RECORD_KINDS[name].fields).map(ticked).join(", ")} |`,
      ),
    ),
    held(`Its \`cause\` is one of ${either(causes().map((c) => c.name))}`),
    held(`in at most ${STEWARD_RECORD_LIMITS.summary.value} characters`),
    held(`Submit at most ${STEWARD_RECORD_LIMITS.records.value} records.`),
  ];
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "registry for the kind the records are kept as in the records registry, record for a record kind a pass submits, field for a field of a record, cause for a cause a cause record names, and limit for a bound of a submission or its strings.",
  },
  record: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "The record kind a field or a cause belongs to (rearm, resume, need, facet, order or cause), and a record kind's own name; null for the registry's kind, a field every kind carries and a bound.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The registry's kind's name, a record kind's name, a field's name (a kind's own field as `<kind>.<field>`, such as `rearm.target`; a field every kind carries by its name alone), a cause, or a bound's name. Unique among the values of one kind.",
  },
  type: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a field, the JSON type of its value (string, string[] for a list of strings, or integer or string); null for every other value.",
  },
  version: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For the registry's kind, the version of its records; null otherwise.",
  },
  limit: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description: "For a bound, its value; null otherwise.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "What it means to a reader that meets it, and what that reader does with it.",
  },
};

const NONE = { type: null, version: null, limit: null } as const;

function values(): DataValue[] {
  const kept = keptKind();
  return [
    {
      kind: "registry",
      record: null,
      name: kept.name,
      ...NONE,
      version: kept.version,
      meaning: kept.meaning,
    },
    ...kinds().map((k) => ({
      kind: "record",
      record: k.name,
      name: k.name,
      ...NONE,
      meaning: k.meaning,
    })),
    ...fields().map((f) => ({
      kind: "field",
      record: f.kind,
      name: f.kind === null ? f.name : `${f.kind}.${f.name}`,
      ...NONE,
      type: f.type,
      meaning: f.meaning,
    })),
    ...causes().map((c) => ({
      kind: "cause",
      record: "cause" satisfies StewardKindName,
      name: c.name,
      ...NONE,
      meaning: c.meaning,
    })),
    ...limits().map((l) => ({
      kind: "limit",
      record: null,
      name: l.name,
      ...NONE,
      limit: l.value,
      meaning: l.meaning,
    })),
  ];
}

export const STEWARD_RECORDS_CHAPTER: Chapter = {
  schemas: [
    ...kinds().map(({ name }) => ({
      name: `steward-${name}`,
      shape: STEWARD_RECORD_SHAPES[name],
    })),
    { name: "steward-submission", shape: STEWARD_SUBMISSION_SHAPE },
  ],
  id: "steward-records",
  title: "Steward records",
  summary:
    "The closed records a steward pass submits for the dispatcher's next tick to check and apply: each kind, its fields, the causes a run's record may name and the bounds of a submission.",
  version: 1,
  status: "provisional",
  planItems: [{ item: 50, epic: 940 }],
  module: "tools/protocol/chapters/steward-records.ts",
  sections: [
    {
      source: `${REGISTRY}#RECORD_KINDS`,
      render: () => recordKindsTable([keptKind()]),
    },
    { source: `${VALUES}#STEWARD_RECORD_KINDS`, render: kindsTable },
    {
      source: `${VALUES}#STEWARD_COMMON_FIELDS,STEWARD_RECORD_KINDS`,
      render: fieldsTable,
    },
    { source: `${VALUES}#STEWARD_CAUSE_VALUES`, render: causesTable },
    { source: `${VALUES}#STEWARD_RECORD_LIMITS`, render: limitsTable },
  ],
  fields: FIELDS,
  values,
  takes: () => [
    `${REGISTRY}#RECORD_KINDS.${KEPT}`,
    ...kinds().map((k) => `${VALUES}#STEWARD_RECORD_KINDS.${k.name}`),
    ...fields().map(fieldEntry),
    ...causes().map((c) => `${VALUES}#STEWARD_CAUSE_VALUES.${c.name}`),
    ...limits().map((l) => `${VALUES}#STEWARD_RECORD_LIMITS.${l.name}`),
  ],
  excluded: [],
  check: (root) => checkHeldPhrases(root, "steward-records", heldPhrases()),
};
