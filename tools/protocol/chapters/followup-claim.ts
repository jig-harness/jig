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

function recordTable(): string {
  const k = followupKind();
  return table(
    ["Kind", "Medium", "Markers", "Version", "Key", "Meaning"],
    [
      [
        ticked(k.name),
        k.medium,
        (k.markers ?? []).map(ticked).join(", "),
        String(k.version),
        k.key === undefined ? "—" : ticked(k.key.source),
        k.meaning,
      ],
    ],
  );
}

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
    ["Field", ...runs().map((run) => `A ${ticked(run)} marker`), "Meaning"],
    Object.entries(FOLLOWUP_FIELDS).map(([name, f]) => [
      ticked(name),
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
    identifies: true,
    description:
      "record for the marker's kind in the records registry, run for a value of its run field, and <run>-outcome (tick-outcome, manual-outcome) for a value of the outcome field of that run's marker.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The record kind's registered name, or the value as the marker's field carries it.",
  },
  run: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For an outcome, the run whose marker carries it; null for the record and the runs.",
  },
  markers: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For the record, its hidden markers, each as written after `<!-- `, separated by a comma and a space; null otherwise.",
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

const NONE = { markers: null, version: null, key: null } as const;

function values(): DataValue[] {
  const k = followupKind();
  return [
    {
      kind: "record",
      name: k.name,
      run: null,
      markers: (k.markers ?? []).join(", "),
      version: k.version,
      key: k.key?.source ?? null,
      meaning: k.meaning,
    },
    ...runs().map((run) => ({
      kind: "run",
      name: run,
      run: null,
      ...NONE,
      meaning: FOLLOWUP_RUNS[run].meaning,
    })),
    ...outcomes().map((o) => ({
      kind: outcomeKind(o.run),
      name: o.name,
      run: o.run,
      ...NONE,
      meaning: o.meaning,
    })),
  ];
}

export const FOLLOWUP_CLAIM_CHAPTER: Chapter = {
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
