/**
 * The chapter on three forge claims: the takeover claim, the dispatcher's
 * launch claim and the merge-ready announcement, generated from their kinds
 * in the records registry and their tables (`FORGE_CLAIM_FIELDS`,
 * `LAUNCH_CLAIM_VALUES`). The follow-up claim, a forge claim too, has a
 * chapter of its own (`followup-claim.ts`).
 *
 * Its values are each kind and its markers, each claim's fields and the
 * launch claim's closed values; each claim's schema is published from the
 * shape its reader validates against (`forge-claim-shapes.ts`).
 */
import { Defect } from "../../../plugin/shared/errors.ts";
import { envelopeShape } from "../../../plugin/shared/records/envelope-shape.ts";
import {
  CLAIM_PR_SHAPE,
  LAUNCH_ATTEMPT_SHAPE,
  LAUNCH_PAYLOAD_SHAPE,
  MERGE_READY_PAYLOAD_SHAPE,
  TAKEOVER_GENERATION_SHAPE,
  TAKEOVER_LEGACY_SHAPE,
  TAKEOVER_PAYLOAD_SHAPE,
} from "../../../plugin/shared/records/forge-claim-shapes.ts";
import {
  FORGE_CLAIM_FIELDS,
  type ForgeClaimField,
  type ForgeClaimKindName,
  LAUNCH_CLAIM_VALUES,
} from "../../../plugin/shared/records/forge-claim-values.ts";
import {
  type RecordKind,
  recordKind,
} from "../../../plugin/shared/records/registry.ts";
import { s } from "../../../plugin/shared/shapes.ts";
import type { Chapter, DataValue, FieldSpec } from "../chapter.ts";
import { table } from "../markdown.ts";
import { recordKindsTable } from "../record-kinds.ts";

const REGISTRY = "plugin/shared/records/registry.ts";
const VALUES = "plugin/shared/records/forge-claim-values.ts";

/** The registry's kinds the chapter takes, in the order it lists them. */
export const FORGE_CLAIM_KINDS = Object.keys(
  FORGE_CLAIM_FIELDS,
) as ForgeClaimKindName[];

/** The launch claim's kind, whose closed values the chapter lists. */
const LAUNCH = "dispatch-launch-claim" satisfies ForgeClaimKindName;

const ticked = (text: string) => `\`${text}\``;

function kindOf(name: string): RecordKind {
  const kind = recordKind(name);
  if (kind === undefined)
    throw new Defect(`the records registry holds no ${name}`);
  return kind;
}

const kinds = () => FORGE_CLAIM_KINDS.map(kindOf);

/** Every claim's fields, claim by claim in the kinds' order. */
const fields = () =>
  FORGE_CLAIM_KINDS.flatMap((claim) =>
    Object.entries(
      FORGE_CLAIM_FIELDS[claim] as Record<string, ForgeClaimField>,
    ).map(([name, f]) => ({ claim, name, ...f })),
  );

/** The launch claim's closed values, field by field. */
const closedValues = () =>
  Object.entries(LAUNCH_CLAIM_VALUES).flatMap(([field, values]) =>
    Object.entries(values).map(([value, v]) => ({
      field,
      value,
      meaning: v.meaning,
    })),
  );

const typeText = (f: ForgeClaimField) =>
  f.nullable === true ? `${f.type} or null` : f.type;

const kindsTable = () => recordKindsTable(kinds());

function fieldsTable(): string {
  return table(
    ["Claim", "Field", "Type", "Carried", "Meaning"],
    fields().map((f) => [
      ticked(f.claim),
      ticked(f.name),
      typeText(f),
      f.carried,
      f.meaning,
    ]),
  );
}

function valuesTable(): string {
  return table(
    ["Field", "Value", "Meaning"],
    closedValues().map((v) => [ticked(v.field), ticked(v.value), v.meaning]),
  );
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "record for a claim's kind in the records registry, marker for one of its hidden markers, field for a field of its record, and value for a closed value of one of the launch claim's fields.",
  },
  claim: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The registered name of the claim's kind the value belongs to: drive-takeover-claim, dispatch-launch-claim or drive-merge-ready.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The kind's registered name, one hidden marker as its comment opens after `<!-- `, a field's name (a field of a launch's end as `end.<field>`), or a closed value as `<field>.<value>` (`action.rearm`).",
  },
  type: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a field, the JSON type of its value (string, integer, boolean, object, or string[] for a list of strings); null for every other value.",
  },
  nullable: {
    type: "boolean",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a field, whether null is a value it may carry; null for every other value.",
  },
  carried: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a field, which of the kind's claims carry it: always, sometimes, or for a field of a launch's end every end, every ended end, every died end, some ended ends or some died ends. Null for every other value.",
  },
  version: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a record, the version Jig's writers write now, which its envelope's v carries; null otherwise.",
  },
  key: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a record, the whole shape of its envelope's key as a regular expression; null otherwise.",
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
  nullable: null,
  carried: null,
  version: null,
  key: null,
} as const;

function values(): DataValue[] {
  return [
    ...kinds().flatMap((k) => [
      {
        kind: "record",
        claim: k.name,
        name: k.name,
        ...NONE,
        version: k.version,
        key: k.key?.source ?? null,
        meaning: k.meaning,
      },
      ...(k.markers ?? []).map((marker) => ({
        kind: "marker",
        claim: k.name,
        name: marker,
        ...NONE,
        meaning: k.meaning,
      })),
    ]),
    ...fields().map((f) => ({
      kind: "field",
      claim: f.claim,
      name: f.name,
      ...NONE,
      type: f.type,
      nullable: f.nullable === true,
      carried: f.carried,
      meaning: f.meaning,
    })),
    ...closedValues().map((v) => ({
      kind: "value",
      claim: LAUNCH,
      name: `${v.field}.${v.value}`,
      ...NONE,
      meaning: v.meaning,
    })),
  ];
}

/**
 * A takeover claim in the envelope, its key `takeover:<generation>`, or in
 * the form written before the envelope, which still reads.
 */
const TAKEOVER_RECORD_SHAPE = s.union([
  s.intersection(
    envelopeShape(kindOf("drive-takeover-claim")),
    s.intersection(
      s.object({ generation: TAKEOVER_GENERATION_SHAPE }),
      TAKEOVER_PAYLOAD_SHAPE,
    ),
  ),
  TAKEOVER_LEGACY_SHAPE,
]);

/** A launch claim: its attempt and pull request beside its own fields. */
const LAUNCH_RECORD_SHAPE = s.intersection(
  envelopeShape(kindOf(LAUNCH)),
  s.intersection(
    s.object({ generation: LAUNCH_ATTEMPT_SHAPE, pr: CLAIM_PR_SHAPE }),
    LAUNCH_PAYLOAD_SHAPE,
  ),
);

/** A merge-ready announcement's record: the envelope, its key naming the head. */
const MERGE_READY_RECORD_SHAPE = s.intersection(
  envelopeShape(kindOf("drive-merge-ready")),
  MERGE_READY_PAYLOAD_SHAPE,
);

export const FORGE_CLAIMS_CHAPTER: Chapter = {
  schemas: [
    { name: "drive-takeover-claim", shape: TAKEOVER_RECORD_SHAPE },
    { name: "dispatch-launch-claim", shape: LAUNCH_RECORD_SHAPE },
    { name: "drive-merge-ready", shape: MERGE_READY_RECORD_SHAPE },
  ],
  id: "forge-claims",
  title: "Forge claims: takeover, launch and merge-ready",
  summary:
    "The claims a driver and a dispatcher post on a pull request: a driver's takeover of another clone's drive, a dispatching host's launch of a drive, and a driver's announcement that a head is safe to merge.",
  version: 1,
  status: "provisional",
  planItems: [
    { item: 40, epic: 517 },
    { item: 49, epic: 865 },
  ],
  module: "tools/protocol/chapters/forge-claims.ts",
  sections: [
    { source: `${REGISTRY}#RECORD_KINDS`, render: kindsTable },
    { source: `${VALUES}#LAUNCH_CLAIM_VALUES`, render: valuesTable },
    { source: `${VALUES}#FORGE_CLAIM_FIELDS`, render: fieldsTable },
  ],
  fields: FIELDS,
  values,
  takes: () => [
    ...FORGE_CLAIM_KINDS.map((k) => `${REGISTRY}#RECORD_KINDS.${k}`),
    ...fields().map((f) => `${VALUES}#FORGE_CLAIM_FIELDS.${f.claim}.${f.name}`),
    ...closedValues().map(
      (v) => `${VALUES}#LAUNCH_CLAIM_VALUES.${v.field}.${v.value}`,
    ),
  ],
  excluded: [],
};
