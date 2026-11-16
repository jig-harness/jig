/**
 * The forge claims' tables (`records/forge-claim-values.ts`) hold what their
 * shapes (`records/forge-claim-shapes.ts`) check and their writers write:
 * each field the table lists for a claim is a field of its shape, carried
 * always exactly where the shape requires it, and each writer writes only
 * the fields the table lists, every field it says is always carried among
 * them.
 */
import { describe, expect, it } from "bun:test";
import { readEnvelope } from "../records/envelope.ts";
import {
  FORGE_CLAIM_FIELDS,
  LAUNCH_CLAIM_FIELDS,
  LAUNCH_CLAIM_VALUES,
  TAKEOVER_CLAIM_FIELDS,
} from "../records/forge-claim-values.ts";
import {
  LAUNCH_END_STATE_SHAPES,
  LAUNCH_PAYLOAD_FIELDS,
  TAKEOVER_PAYLOAD_FIELDS,
} from "../records/forge-claim-shapes.ts";
import { type ClaimDraft, claimBody } from "../records/forge-claims.ts";
import { markerText } from "../records/envelope.ts";
import {
  endedClaim,
  LAUNCH_CLAIM,
  launchClaim,
} from "../records/launch-claims.ts";
import { RECORD_KINDS } from "../records/registry.ts";
import type { LaunchDraft, LaunchEnd } from "../records/shared.ts";
import type { Shape } from "../shapes.ts";
import {
  renderClaim,
  TAKEOVER_CLAIM,
} from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import {
  announcementDraft,
  MERGE_READY,
} from "../../skills/drive-pr/scripts/lib/announce.ts";

const WRITER = { host: "sha256:0123456789abcdef" };
const AT = "2026-11-05T09:00:00.000Z";
const RECORD = "20261105T090000Z-aaaaaaaa";

/** The fields an object shape declares, and those it requires. */
function fieldsOf(shape: Shape): { all: string[]; required: string[] } {
  const schema = shape.schema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  return { all: Object.keys(schema.properties), required: schema.required };
}

const optional = (shape: Shape) => shape.optional === true;

/** Whether an object shape carries a field: always, sometimes or never. */
function carriedIn(shape: Shape, name: string): string {
  const { all, required } = fieldsOf(shape);
  if (!all.includes(name)) return "never";
  return required.includes(name) ? "always" : "sometimes";
}

/** What a table's `carried` for a field of a launch's end says of an end in `state`. */
function carriedInState(carried: string, state: string): string {
  const said: Record<string, string> = {
    "every end": "always",
    [`every ${state} end`]: "always",
    [`some ${state} ends`]: "sometimes",
  };
  return said[carried] ?? "never";
}

/** The envelope's own fields, which a table lists only where the claim's key repeats one. */
const ENVELOPE_FIELDS_LISTED = ["generation"];

describe("the forge claims' tables", () => {
  it("list a claim's fields for each of the three registry kinds, and only those", () => {
    for (const name of Object.keys(FORGE_CLAIM_FIELDS)) {
      const kind = RECORD_KINDS.find((k) => k.name === name);
      expect(kind?.medium).toBe("forge");
      expect(kind?.key).toBeDefined();
    }
  });

  it("list every field of the takeover claim's shape, each always carried", () => {
    const listed = Object.keys(TAKEOVER_CLAIM_FIELDS).filter(
      (f) => !ENVELOPE_FIELDS_LISTED.includes(f),
    );
    expect(listed).toEqual(Object.keys(TAKEOVER_PAYLOAD_FIELDS));
    for (const [name, shape] of Object.entries(TAKEOVER_PAYLOAD_FIELDS))
      expect([name, optional(shape)]).toEqual([
        name,
        TAKEOVER_CLAIM_FIELDS[name as keyof typeof TAKEOVER_PAYLOAD_FIELDS]
          .carried !== "always",
      ]);
  });

  it("list every field of the launch claim's shape, always carried exactly where the shape requires it", () => {
    const top = Object.keys(LAUNCH_CLAIM_FIELDS).filter(
      (f) => !f.includes(".") && !["generation", "pr"].includes(f),
    );
    expect(top).toEqual(Object.keys(LAUNCH_PAYLOAD_FIELDS));
    for (const [name, shape] of Object.entries(LAUNCH_PAYLOAD_FIELDS))
      expect([name, optional(shape)]).toEqual([
        name,
        LAUNCH_CLAIM_FIELDS[name as keyof typeof LAUNCH_PAYLOAD_FIELDS]
          .carried !== "always",
      ]);
  });

  it("list every field of each end state's shape, carried as the shape requires it in each state", () => {
    const states = Object.keys(LAUNCH_END_STATE_SHAPES);
    expect(states).toEqual(Object.keys(LAUNCH_CLAIM_VALUES["end.state"]));
    const listed = Object.entries(LAUNCH_CLAIM_FIELDS).filter(([f]) =>
      f.startsWith("end."),
    );
    const declared = new Set(
      Object.values(LAUNCH_END_STATE_SHAPES).flatMap((s) => fieldsOf(s).all),
    );
    expect(listed.map(([f]) => f.slice("end.".length)).sort()).toEqual(
      [...declared].sort(),
    );
    for (const [field, { carried }] of listed) {
      const name = field.slice("end.".length);
      for (const [state, shape] of Object.entries(LAUNCH_END_STATE_SHAPES))
        expect({ field, state, how: carriedIn(shape, name) }).toEqual({
          field,
          state,
          how: carriedInState(carried, state),
        });
    }
  });

  it("list the actions the launch claim's shape accepts", () => {
    const action = LAUNCH_PAYLOAD_FIELDS.action.schema as { enum: string[] };
    expect(action.enum).toEqual(Object.keys(LAUNCH_CLAIM_VALUES.action));
  });
});

/** A claim's record as its writer writes it, envelope and payload together. */
function written(kind: typeof LAUNCH_CLAIM, draft: ClaimDraft) {
  const data = markerText(claimBody(kind, draft), kind.data.slice(5));
  if (!data.ok) throw new Error(data.failure.reason);
  const read = readEnvelope(JSON.parse(data.value), kind.name);
  if (!read.ok) throw new Error(read.failure.reason);
  return { ...read.value.payload, ...read.value.envelope };
}

/** The fields a table lists that are always carried, top-level only. */
const always = (fields: Record<string, { carried: string }>) =>
  Object.entries(fields)
    .filter(([f, v]) => !f.includes(".") && v.carried === "always")
    .map(([f]) => f);

const ENVELOPE = ["kind", "v", "key", "writer", "at", "generation"];

describe("the forge claims' writers", () => {
  const draft: LaunchDraft = {
    stage: "drive",
    pr: 12,
    run: "tick",
    action: "rearm",
    record: RECORD,
    host: "sha256:aaaaaaaaaaaaaaaa",
    owner: null,
    facts: null,
    writer: WRITER,
  };
  const full: LaunchDraft = {
    ...draft,
    action: "takeover",
    owner: true,
    facts: "generation 3",
    change: "head abc",
    earlier: ["head 123"],
    conflictStop: true,
  };
  const posted = launchClaim(full, 2, AT);
  const record = {
    key: "drive",
    generation: 2,
    at: AT,
    writer: WRITER,
    payload: posted.payload,
    legacy: false,
  };
  const ends: LaunchEnd[] = [
    { state: "ended", at: AT, exit: 0, outcome: null },
    {
      state: "ended",
      at: AT,
      exit: null,
      outcome: null,
      by: "agent",
      cause: "needs-person",
    },
    { state: "died", at: AT, reason: "gone" },
    { state: "died", at: AT, reason: "never ran", executed: false },
  ];

  it("write only the launch claim's listed fields, every always-carried one among them", () => {
    const listed = Object.keys(LAUNCH_CLAIM_FIELDS).filter(
      (f) => !f.includes("."),
    );
    for (const d of [
      launchClaim(draft, 1, AT),
      posted,
      ...ends.map((end) => endedClaim("drive", record, 12, end, WRITER)),
    ]) {
      const json = written(LAUNCH_CLAIM, d);
      const own = Object.keys(json).filter(
        (f) => !ENVELOPE.includes(f) || ENVELOPE_FIELDS_LISTED.includes(f),
      );
      expect(own.filter((f) => !listed.includes(f))).toEqual([]);
      expect(
        always(LAUNCH_CLAIM_FIELDS).filter((f) => !own.includes(f)),
      ).toEqual([]);
      const end = (json as { end?: Record<string, unknown> }).end;
      if (end !== undefined)
        for (const f of Object.keys(end))
          expect(Object.hasOwn(LAUNCH_CLAIM_FIELDS, `end.${f}`)).toBe(true);
    }
  });

  it("write only the takeover claim's listed fields, all of them", () => {
    const body = renderClaim(
      { actor: "wt-bbbbbbbbbbbbbbbb", clone: "clone-b", generation: 4, at: AT },
      WRITER,
    );
    const data = markerText(body, "drive-pr-takeover-claim-data");
    if (!data.ok) throw new Error(data.failure.reason);
    const read = readEnvelope(JSON.parse(data.value), TAKEOVER_CLAIM.name);
    if (!read.ok) throw new Error(read.failure.reason);
    const own = [
      ...Object.keys(read.value.payload),
      ...(read.value.envelope.generation === undefined ? [] : ["generation"]),
    ];
    expect(own.sort()).toEqual(Object.keys(TAKEOVER_CLAIM_FIELDS).sort());
  });

  it("write a merge-ready announcement with no field beside the envelope", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const json = written(
      MERGE_READY,
      announcementDraft(
        head,
        `done\n\n<!-- drive-pr-merge-ready: ${head} -->`,
        WRITER,
      ),
    );
    expect(Object.keys(json).filter((f) => !ENVELOPE.includes(f))).toEqual([]);
    expect(Object.keys(FORGE_CLAIM_FIELDS["drive-merge-ready"])).toEqual([]);
  });
});
