/**
 * The chapter on the follow-up claim and its result, generated from the
 * records registry's `dispatch-followup` kind and the follow-up marker's
 * tables (`FOLLOWUP_RUNS`, `FOLLOWUP_OUTCOMES`, `FOLLOWUP_FIELDS`).
 *
 * Its values are the kind itself, the runs and each run's outcomes; the
 * payload's fields are a shape, printed in a section of their own.
 */
import { Defect } from "../../../plugin/shared/errors.ts";
import {
  FOLLOWUP_FIELDS,
  FOLLOWUP_OUTCOMES,
  FOLLOWUP_RUNS,
  type FollowupRun,
} from "../../../plugin/shared/records/followup-values.ts";
import {
  type RecordKind,
  recordKind,
} from "../../../plugin/shared/records/registry.ts";
import type { Chapter, DataValue, FieldSpec } from "../chapter.ts";
import { table } from "../markdown.ts";
import { recordKindsTable } from "../record-kinds.ts";
import { s } from "../../../plugin/shared/shapes.ts";
import { envelopeShape } from "../../../plugin/shared/records/envelope-shape.ts";
import {
  FOLLOWUP_PAYLOAD_SHAPE,
  FOLLOWUP_RUN_SHAPE,
} from "../../../plugin/shared/records/followup-shapes.ts";

const REGISTRY = "plugin/shared/records/registry.ts";
const VALUES = "plugin/shared/records/followup-values.ts";

/** The registry's kind the chapter takes. */
export const FOLLOWUP_KIND_NAME = "dispatch-followup";

const ticked = (text: string) => `\`${text}\``;

function followupKind(): RecordKind {
  const kind = recordKind(FOLLOWUP_KIND_NAME);
  if (kind === undefined)
    throw new Defect(`the records registry holds no ${FOLLOWUP_KIND_NAME}`);
  return kind;
}

const runs = () => Object.keys(FOLLOWUP_RUNS) as FollowupRun[];

/** The kind of a run's outcome values in the data file. */
export const outcomeKind = (run: FollowupRun) => `${run}-outcome`;

/** Each run's outcomes, run by run in the runs' order. */
const outcomes = () =>
  runs().flatMap((run) =>
    Object.entries(FOLLOWUP_OUTCOMES[run]).map(([name, v]) => ({
      run,
      name,
      meaning: v.meaning,
    })),
  );

const recordTable = () => recordKindsTable([followupKind()]);

function runsTable(): string {
  return table(
    ["Run", "Meaning"],
    runs().map((run) => [ticked(run), FOLLOWUP_RUNS[run].meaning]),
  );
}

function outcomesTable(): string {
  return table(
    ["Outcome", "Run", "Meaning"],
    outcomes().map((o) => [ticked(o.name), ticked(o.run), o.meaning]),
  );
}

function fieldsTable(): string {
  return table(
    [
      "Field",
      "Type",
      ...runs().map((run) => `A ${ticked(run)} marker`),
      "Meaning",
    ],
    Object.entries(FOLLOWUP_FIELDS).map(([name, f]) => [
      ticked(name),
      f.type,
      ...runs().map((run) => {
        const carried = (f.carriedBy as Partial<Record<FollowupRun, string>>)[
          run
        ];
        return carried ?? "never";
      }),
      f.meaning,
    ]),
  );
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "record for the marker's kind in the records registry, marker for one of its hidden markers, run for a value of its run field, <run>-outcome (tick-outcome, manual-outcome) for a value of the outcome field of that run's marker, and field for a field of its payload.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The record kind's registered name, one hidden marker as its comment opens after `<!-- `, a run's name, an outcome as `<run>.<outcome>` (`tick.done`), or the payload field's name.",
  },
  run: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For an outcome, the run whose marker carries it; null for every other value.",
  },
  type: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a payload field, the JSON type of its value; null for every other value.",
  },
  carriedBy: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a payload field, the runs whose markers carry it, each with always or sometimes, as `tick (always), manual (sometimes)`; a marker of a run not named never carries it. Null for every other value.",
  },
  version: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For the record, the version Jig's writers write now, which its envelope's v carries; null otherwise.",
  },
  key: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For the record, the whole shape of its envelope's key as a regular expression; null otherwise.",
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

const NONE = {
  type: null,
  carriedBy: null,
  version: null,
  key: null,
} as const;

const carriedBy = (f: (typeof FOLLOWUP_FIELDS)[keyof typeof FOLLOWUP_FIELDS]) =>
  Object.entries(f.carriedBy)
    .map(([run, how]) => `${run} (${how})`)
    .join(", ");

function values(): DataValue[] {
  const k = followupKind();
  return [
    {
      kind: "record",
      name: k.name,
      run: null,
      type: null,
      carriedBy: null,
      version: k.version,
      key: k.key?.source ?? null,
      meaning: k.meaning,
    },
    ...(k.markers ?? []).map((marker) => ({
      kind: "marker",
      name: marker,
      run: null,
      ...NONE,
      meaning: k.meaning,
    })),
    ...runs().map((run) => ({
      kind: "run",
      name: run,
      run: null,
      ...NONE,
      meaning: FOLLOWUP_RUNS[run].meaning,
    })),
    ...outcomes().map((o) => ({
      kind: outcomeKind(o.run),
      name: `${o.run}.${o.name}`,
      run: o.run,
      ...NONE,
      meaning: o.meaning,
    })),
    ...Object.entries(FOLLOWUP_FIELDS).map(([name, f]) => ({
      kind: "field",
      name,
      run: null,
      ...NONE,
      type: f.type,
      carriedBy: carriedBy(f),
      meaning: f.meaning,
    })),
  ];
}

/** A version-1 record names its pull request in the envelope key; its pr field is not read. */
const FOLLOWUP_RECORD_SHAPE = s.union([
  s.intersection(
    envelopeShape(followupKind()),
    s.intersection(
      s.object({ v: s.literal(1), pr: s.optional(s.unknown()) }),
      FOLLOWUP_RUN_SHAPE,
    ),
  ),
  s.intersection(
    envelopeShape(followupKind()),
    s.intersection(
      s.object({
        v: s.literal(followupKind().version),
        key: s.literal("followup"),
      }),
      FOLLOWUP_PAYLOAD_SHAPE,
    ),
  ),
]);

export const FOLLOWUP_CLAIM_CHAPTER: Chapter = {
  schemas: [
    {
      name: "followup-claim",
      shape: FOLLOWUP_RECORD_SHAPE,
    },
    {
      name: "followup-result",
      shape: s.intersection(
        FOLLOWUP_RECORD_SHAPE,
        s.object({ outcome: s.enum(["done", "failed"]) }),
      ),
    },
  ],
  id: "followup-claim",
  title: "The follow-up claim and its result",
  summary:
    "The marker that claims a merged pull request's follow-up: who took it, a dispatcher's tick or a person's run, and how it ended.",
  version: 1,
  status: "stable",
  planItems: [],
  module: "tools/protocol/chapters/followup-claim.ts",
  sections: [
    { source: `${REGISTRY}#RECORD_KINDS`, render: recordTable },
    { source: `${VALUES}#FOLLOWUP_RUNS`, render: runsTable },
    { source: `${VALUES}#FOLLOWUP_OUTCOMES`, render: outcomesTable },
    { source: `${VALUES}#FOLLOWUP_FIELDS`, render: fieldsTable },
  ],
  fields: FIELDS,
  values,
  takes: () => [
    `${REGISTRY}#RECORD_KINDS.${FOLLOWUP_KIND_NAME}`,
    ...runs().map((run) => `${VALUES}#FOLLOWUP_RUNS.${run}`),
    ...outcomes().map((o) => `${VALUES}#FOLLOWUP_OUTCOMES.${o.run}.${o.name}`),
    ...Object.keys(FOLLOWUP_FIELDS).map(
      (f) => `${VALUES}#FOLLOWUP_FIELDS.${f}`,
    ),
  ],
  excluded: [],
};
