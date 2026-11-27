/**
 * The chapter on the hidden comment markers Jig writes and reads on the
 * forge and the tracker, generated from the records registry
 * (`RECORD_KINDS`, `NOT_RECORDS`) and the record envelope's codec
 * (`ENVELOPE_FIELDS`, `encodeMarker`).
 *
 * It lists every forge and tracker kind that carries a hidden marker, except
 * the forge claims, which have chapters of their own: the follow-up claim
 * (`followup-claim.ts`) and the takeover, launch and merge-ready claims
 * (`forge-claims.ts`). A kind on another medium is outside the chapter, whatever it carries; a
 * forge or tracker kind it does not list is named in `EXCLUSIONS` with why.
 */
import { Defect } from "../../../plugin/shared/errors.ts";
import {
  ENVELOPE_FIELDS,
  type EnvelopeField,
  encodeMarker,
} from "../../../plugin/shared/records/envelope.ts";
import {
  NOT_RECORDS,
  RECORD_KINDS,
  type RecordKind,
  recordKind,
} from "../../../plugin/shared/records/registry.ts";
import type { Chapter, DataValue, FieldSpec } from "../chapter.ts";
import { table } from "../markdown.ts";
import { checkHeldPhrases } from "../held.ts";
import { s } from "../../../plugin/shared/shapes.ts";
import {
  ENVELOPE_SHAPE,
  envelopeShape,
} from "../../../plugin/shared/records/envelope-shape.ts";
import {
  ANSWER_PAYLOAD_SHAPE,
  REARM_REQUEST_PAYLOAD_SHAPE,
  ATTACHMENT_MARKER_SHAPE,
  CLAIM_MARKER_PAYLOAD_SHAPE,
  CLAIM_OUTCOME_PAYLOAD_SHAPE,
} from "../../../plugin/shared/records/marker-shapes.ts";
import { REFLECTION_EVENT_SHAPE } from "../../../plugin/skills/reflect/scripts/lib/event-shapes.ts";
import { FOOTPRINT_SHAPE } from "../../../plugin/shared/footprint.ts";
import {
  LEDGER_PAYLOAD_SHAPE,
  LEDGER_PAYLOAD_FIELDS,
} from "../../../plugin/skills/drive-pr/scripts/lib/state/ledger-shapes.ts";

const REGISTRY = "plugin/shared/records/registry.ts";
const ENVELOPE = "plugin/shared/records/envelope.ts";

function enveloped(name: string, shape: Parameters<typeof s.intersection>[1]) {
  const kind = recordKind(name);
  if (kind === undefined)
    throw new Defect(`the registry holds no ${name} kind`);
  return s.intersection(envelopeShape(kind), shape);
}

/** Stable kinds carrying JSON documents; other marker grammars are explicitly listed below. */
export const MARKER_SCHEMAS = {
  "tracker-footprint": [
    {
      name: "tracker-footprint",
      shape: enveloped("tracker-footprint", FOOTPRINT_SHAPE),
    },
  ],
  "drive-ledger": [
    {
      name: "drive-ledger",
      shape: s.union([
        enveloped("drive-ledger", LEDGER_PAYLOAD_SHAPE),
        s.object({
          ...LEDGER_PAYLOAD_FIELDS,
          ledgerVersion: s.enum([1, 2, 3]),
          kind: s.optional(s.never()),
        }),
      ]),
    },
  ],
  "drive-answer": [
    {
      name: "drive-answer",
      shape: enveloped("drive-answer", ANSWER_PAYLOAD_SHAPE),
    },
  ],
  "dispatch-rearm-request": [
    {
      name: "dispatch-rearm-request",
      shape: enveloped("dispatch-rearm-request", REARM_REQUEST_PAYLOAD_SHAPE),
    },
  ],
  "tracker-claim-marker": [
    {
      name: "tracker-claim-marker",
      shape: enveloped("tracker-claim-marker", CLAIM_MARKER_PAYLOAD_SHAPE),
    },
    {
      name: "tracker-claim-outcome",
      shape: enveloped("tracker-claim-marker", CLAIM_OUTCOME_PAYLOAD_SHAPE),
    },
  ],
  "tracker-attachment": [
    { name: "tracker-attachment", shape: ATTACHMENT_MARKER_SHAPE },
  ],
  "reflection-github-store": [
    { name: "reflection-record", shape: REFLECTION_EVENT_SHAPE },
  ],
} as const;

/** These markers carry text or delimit prose, never a parsed JSON document. */
export const NON_JSON_MARKERS: Readonly<Record<string, string>> = {
  "summary-answer": "A fingerprint in a marker line.",
  "thread-reply": "A marker at the end of a prose reply.",
  "deferred-section": "A prose section with space-separated entry attributes.",
  "ai-review-summary": "Reviewer prose and commit marker text.",
  "ai-review-round": "Reviewer round and backlog marker text.",
  "coderabbit-comment": "Reviewer marker text.",
  "coderabbit-review-body": "Reviewer finding identifiers in prose.",
  "do-item-pr-association": "A pull-request address in a comment marker.",
  "deferred-batch": "A batch key on a marker line.",
  "tracker-related": "Relation keys on marker lines.",
  "tracker-blocked": "A prose state-transition marker.",
  "issue-fields-sweep": "A prose facet-sweep marker.",
  "fleet-health-suspicion": "A prose suspicion marker.",
  "epic-acceptance-verdict": "A verdict word on a marker line.",
  "epic-sweep": "A digest on an epic closure proposal marker.",
  "epic-waiver": "A marker on a person's epic closure decision.",
};

/** The media whose kinds the chapter covers. */
export const MEDIA: readonly string[] = ["forge", "tracker"];

const LABEL = "a label on the pull request, not a hidden marker";
const ITEM =
  "the item's own assignee and state on the tracker, not a hidden marker";
const FORGE_CLAIM =
  "a forge claim, which has a chapter of its own: [Forge claims: takeover, launch and merge-ready](forge-claims.md)";

/** The forge and tracker kinds the chapter does not list, each with why. */
export const EXCLUSIONS: Readonly<Record<string, string>> = {
  "drive-takeover-claim": FORGE_CLAIM,
  "dispatch-followup":
    "the follow-up claim, which has a chapter of its own: [The follow-up claim and its result](followup-claim.md)",
  "dispatch-launch-claim": FORGE_CLAIM,
  "drive-merge-ready": FORGE_CLAIM,
  "scanner-finding-reply":
    "its marker line is written by the session the resolve-review-comments skill instructs, not by Jig's code, so the registry holds no marker for it; [RECORDS.md](../RECORDS.md) gives its form",
  "ci-hold-label": LABEL,
  "dispatch-command-label": LABEL,
  "dispatch-state-label": LABEL,
  "tracker-claim": ITEM,
  "dispatch-pickup-assignment": ITEM,
  "dispatch-pool-readiness":
    "the item's own state on the tracker, and who moved it there, not a hidden marker",
  "deferred-issue":
    "an issue whose description names the finding, not a hidden marker",
  "reflection-escalation":
    "an issue's label and a line of its description, not a hidden marker",
};

const EXCLUDED: readonly string[] = Object.keys(EXCLUSIONS);

const onTheseMedia = (k: RecordKind) => MEDIA.includes(k.medium);

/** The kinds the chapter lists, in the registry's order. */
const kinds = (): RecordKind[] =>
  RECORD_KINDS.filter((k) => onTheseMedia(k) && !EXCLUDED.includes(k.name));

/** The kinds the chapter leaves out, in the registry's order. */
const leftOut = (): RecordKind[] =>
  RECORD_KINDS.filter((k) => onTheseMedia(k) && EXCLUDED.includes(k.name));

const MARKER_SEPARATOR = ", ";
const JIG = "Jig";

const ticked = (text: string) => `\`${text}\``;
const writtenBy = (k: RecordKind) => k.foreign ?? JIG;

function kindsTable(): string {
  return table(
    ["Kind", "Medium", "Markers", "Version", "Key", "Written by", "Meaning"],
    kinds().map((k) => [
      ticked(k.name),
      k.medium,
      (k.markers ?? []).map(ticked).join(MARKER_SEPARATOR),
      String(k.version),
      k.key === undefined ? "—" : ticked(k.key.source),
      writtenBy(k),
      k.meaning,
    ]),
  );
}

/** The record a marker's example carries: a sent answer, as the codec writes it. */
const EXAMPLE_KIND = "drive-answer";

/** The marker form, as the codec itself writes it for an example record. */
function example(): string {
  const kind = recordKind(EXAMPLE_KIND);
  const marker = kind?.markers?.[0];
  if (kind === undefined || marker === undefined)
    throw new Defect(
      `the registry holds no ${EXAMPLE_KIND} kind with a marker`,
    );
  return encodeMarker(
    marker,
    {
      kind: kind.name,
      v: kind.version,
      key: "answer:pickup",
      writer: { login: "example-login", host: "sha256:0123456789abcdef" },
      at: "2026-01-01T00:00:00.000Z",
    },
    { pr: 12 },
  );
}

function envelopeSection(): string {
  const fields = table(
    ["Field", "Type", "Required", "Meaning"],
    Object.entries(ENVELOPE_FIELDS).map(([name, f]) => [
      ticked(name),
      f.type,
      f.required ? "yes" : "no",
      f.meaning,
    ]),
  );
  return [
    fields,
    "",
    `A ${ticked(EXAMPLE_KIND)} record, as the codec writes it in its marker:`,
    "",
    "```text",
    example(),
    "```",
  ].join("\n");
}

function notRecordsTable(): string {
  return table(
    ["Marker", "Why it is not a record"],
    NOT_RECORDS.map((r) => [ticked(r.marker), r.why]),
  );
}

function leftOutTable(): string {
  return table(
    ["Kind", "Medium", "Why it is not listed"],
    leftOut().map((k) => [ticked(k.name), k.medium, EXCLUSIONS[k.name] ?? ""]),
  );
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "active for a value in force; tombstone for a value withdrawn, which the chapter keeps listed so its identity is never reused. It is not part of a value's identity, so withdrawing a value changes only this field.",
  },
  name: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "The record kind's name in the records registry, which an enveloped record's kind field carries; null for a marker that is not a record.",
  },
  part: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "marker for a hidden marker of a record kind, not-record for a marker that is not a record, envelope-field for a field of the record envelope.",
  },
  marker: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "One hidden marker, as its comment opens after `<!-- `; what follows it is its kind's own. A kind with several markers has one value for each. For an envelope field, the field's name.",
  },
  fieldType: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For an envelope field, the JSON type of its value; null for every other value.",
  },
  fieldRequired: {
    type: "boolean",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For an envelope field, whether every record carries it; null for every other value.",
  },
  medium: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description: "forge or tracker; null for a marker that is not a record.",
  },
  version: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "The schema version Jig's writers write now, which its envelope's v carries; 0 for a kind whose records carry no version; null for a marker that is not a record.",
  },
  key: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a kind whose records carry the envelope, the whole shape of its key as a regular expression; null otherwise.",
  },
  writtenBy: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "Jig, or for a kind Jig only reads, the tool or the person that writes it; null for a marker that is not a record.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "What the record is for to a reader that meets it, and what that reader does with it; for a marker that is not a record, why it is not one.",
  },
};

/** The `kind` of a value in force; a withdrawn one reads `tombstone`. */
const ACTIVE = "active";

/** One value for each of the kind's markers, so a marker added to a kind is a value added. */
function kindValues(k: RecordKind): DataValue[] {
  return (k.markers ?? []).map((marker) => ({
    kind: ACTIVE,
    name: k.name,
    part: "marker",
    marker,
    fieldType: null,
    fieldRequired: null,
    medium: k.medium,
    version: k.version,
    key: k.key?.source ?? null,
    writtenBy: writtenBy(k),
    meaning: k.meaning,
  }));
}

const envelopeValue = ([field, f]: [string, EnvelopeField]): DataValue => ({
  kind: ACTIVE,
  name: null,
  part: "envelope-field",
  marker: field,
  fieldType: f.type,
  fieldRequired: f.required,
  medium: null,
  version: null,
  key: null,
  writtenBy: null,
  meaning: f.meaning,
});

const notRecordValue = (r: (typeof NOT_RECORDS)[number]): DataValue => ({
  kind: ACTIVE,
  name: null,
  part: "not-record",
  marker: r.marker,
  fieldType: null,
  fieldRequired: null,
  medium: null,
  version: null,
  key: null,
  writtenBy: null,
  meaning: r.why,
});

export const COMMENT_MARKERS: Chapter = {
  schemas: [
    { name: "record-envelope", shape: ENVELOPE_SHAPE },
    ...Object.values(MARKER_SCHEMAS).flat(),
  ],
  id: "comment-markers",
  check: (root) =>
    checkHeldPhrases(root, "comment-markers", [
      {
        file: "plugin/skills/do-item/SKILL.md",
        text: `<!-- ${recordKind("do-item-pr-association")?.markers?.[0]}: <PR URL> -->`,
      },
    ]),
  title: "Hidden comment markers on the forge and the tracker",
  summary:
    "The hidden markers Jig writes and reads in comments and bodies on the forge and the tracker: what record each marks, who writes it, its version and what it means.",
  version: 2,
  status: "stable",
  planItems: [],
  module: "tools/protocol/chapters/comment-markers.ts",
  sections: [
    { source: `${REGISTRY}#RECORD_KINDS`, render: kindsTable },
    {
      source: `${ENVELOPE}#ENVELOPE_FIELDS,encodeMarker`,
      render: envelopeSection,
    },
    { source: `${REGISTRY}#NOT_RECORDS`, render: notRecordsTable },
    { source: `${REGISTRY}#RECORD_KINDS`, render: leftOutTable },
  ],
  fields: FIELDS,
  values: (): DataValue[] => [
    ...kinds().flatMap(kindValues),
    ...NOT_RECORDS.map(notRecordValue),
    ...Object.entries(ENVELOPE_FIELDS).map(envelopeValue),
  ],
  takes: () => [
    ...kinds().map((k) => `${REGISTRY}#RECORD_KINDS.${k.name}`),
    ...NOT_RECORDS.map((r) => `${REGISTRY}#NOT_RECORDS.${r.marker}`),
    ...Object.keys(ENVELOPE_FIELDS).map(
      (f) => `${ENVELOPE}#ENVELOPE_FIELDS.${f}`,
    ),
  ],
  excluded: EXCLUDED,
};
