/** Published schemas are generated and independently validate the actual writers' JSON. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedRecords } from "../../../plugin/dispatch/lib/steward.ts";
import { parseRule } from "../../../plugin/shared/rule-matcher.ts";
import { s } from "../../../plugin/shared/shapes.ts";
import {
  encodeMarker,
  markerText,
} from "../../../plugin/shared/records/envelope.ts";
import {
  claimBody,
  readClaim,
} from "../../../plugin/shared/records/forge-claims.ts";
import {
  endedClaim,
  FOLLOWUP_CLAIM,
  LAUNCH_CLAIM,
  launchClaim,
  manualClaim,
  tickClaim,
} from "../../../plugin/shared/records/launch-claims.ts";
import type { LaunchDraft } from "../../../plugin/shared/records/shared.ts";
import {
  announcementDraft,
  headMarker,
  MERGE_READY,
} from "../../../plugin/skills/drive-pr/scripts/lib/announce.ts";
import {
  claimMarkerBody,
  claimOutcomeBody,
} from "../../../plugin/skills/do-item/scripts/lib/claim-marker.ts";
import { answerComment } from "../../../plugin/skills/drive-pr/scripts/lib/answer-comment.ts";
import {
  parseInboxMessage,
  appendNote,
  appendDirective,
  appendOutboxRecord,
  inboxPath,
  outboxPath,
} from "../../../plugin/skills/drive-pr/scripts/lib/state/mailbox.ts";
import {
  ledgerFromState,
  renderLedger,
  parseLedger,
  renderClaim,
  TAKEOVER_CLAIM,
} from "../../../plugin/skills/drive-pr/scripts/lib/state/ledger.ts";
import { freshState } from "../../../plugin/skills/drive-pr/scripts/lib/state/schema.ts";
import {
  carriedBody,
  linkBody,
  markerOf,
} from "../../../plugin/skills/do-item/scripts/lib/tracker/github/attachments.ts";
import {
  eventText,
  newId,
} from "../../../plugin/skills/reflect/scripts/lib/events.ts";
import { sampleFinding } from "../../../plugin/skills/reflect/scripts/store-contract.ts";
import {
  commentsFor,
  recordsIn,
} from "../../../plugin/skills/reflect/scripts/lib/github/model.ts";
import {
  checkParkedDecision,
  isParkedDecision,
} from "../../../plugin/shared/decisions/park.ts";
import {
  frameStationDecision,
  type StationFacts,
} from "../../../plugin/shared/decisions/station.ts";
import { advisoryDecision } from "../../../plugin/skills/drive-pr/scripts/lib/ci-special-checks.ts";
import { cancelledCiDecision } from "../../../plugin/skills/drive-pr/scripts/lib/cancelled-recovery-live.ts";
import { CHAPTERS } from "../chapters.ts";
import { schemaFile, schemaOf } from "../chapter.ts";
import {
  COMMENT_MARKERS,
  MARKER_SCHEMAS,
  NON_JSON_MARKERS,
} from "../chapters/comment-markers.ts";
import { generate } from "../generate.ts";
import { planOutputs, staleness } from "../outputs.ts";
import { cleanUp, fixtureChapter, layout, put, tempDir } from "./fixture.ts";
import {
  expectSchemaAccepts,
  expectSchemaRejects,
  schemaValidator,
} from "./schema-validator.ts";

afterEach(cleanUp);
const at = "2026-01-01T00:00:00.000Z";
const writer = { host: "example-host" };
function published(name: string) {
  const chapter = CHAPTERS.find((c) =>
    c.schemas?.some((item) => item.name === name),
  );
  const item = chapter?.schemas?.find((item) => item.name === name);
  if (chapter === undefined || item === undefined)
    throw new Error(`missing ${name}`);
  return schemaOf(chapter, name, item.shape);
}
function markerJson(body: string, marker: string) {
  const read = markerText(body, marker);
  if (!read.ok) throw new Error(read.failure.reason);
  return JSON.parse(read.value);
}

describe("schema generation", () => {
  test("rejects duplicate schema names, even across chapters", () => {
    const root = tempDir("duplicate-schema");
    const chapters = [fixtureChapter(), fixtureChapter({ id: "other" })].map(
      (c) => ({ ...c, schemas: [{ name: "same", shape: s.object({}) }] }),
    );
    layout(root, chapters);
    expect(
      planOutputs(root, chapters).findings.some((f) =>
        f.problem.includes("schema same"),
      ),
    ).toBe(true);
  });
  test("publishes versioned draft schemas and detects stale JSON semantically", () => {
    const root = tempDir("schema");
    const chapter = {
      ...fixtureChapter({ version: 3 }),
      schemas: [{ name: "sample", shape: s.object({ value: s.string() }) }],
    };
    layout(root, [chapter]);
    const result = generate({ root, chapters: [chapter], check: false });
    expect(result.findings).toEqual([]);
    expect(result.written).toContain(schemaFile("sample"));
    const schema = JSON.parse(
      readFileSync(join(root, schemaFile("sample")), "utf8"),
    );
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toContain("/fixture/v3/schemas/sample.json");
    const output = planOutputs(root, [chapter]).outputs.find(
      (o) => o.path === schemaFile("sample"),
    );
    if (!output) throw new Error("missing output");
    put(root, output.path, JSON.stringify(schema));
    expect(staleness(root, output)).toEqual([]);
    expect(
      generate({ root, chapters: [chapter], check: false }).written,
    ).toContain(output.path);
    expect(readFileSync(join(root, output.path), "utf8")).toContain(
      '"required": ["value"]',
    );
    put(root, output.path, JSON.stringify({ ...schema, type: "array" }));
    expect(staleness(root, output)).not.toEqual([]);
  });
  test("compiles every declared schema with an independent draft 2020-12 validator", () => {
    for (const chapter of CHAPTERS)
      for (const { name, shape } of chapter.schemas ?? [])
        expect(schemaValidator(schemaOf(chapter, name, shape))).toBeFunction();
  });
  test("accounts for every stable marker kind, and publishes the forge claims and the steward's records from their own chapters alone", () => {
    const kinds = [
      ...new Set(
        COMMENT_MARKERS.values()
          .filter((v) => v.part === "marker" && v.name !== null)
          .map((v) => String(v.name)),
      ),
    ];
    expect(
      [...Object.keys(MARKER_SCHEMAS), ...Object.keys(NON_JSON_MARKERS)].sort(),
    ).toEqual(kinds.sort());
    for (const reason of Object.values(NON_JSON_MARKERS))
      expect(reason.trim()).not.toBe("");
    for (const chapter of CHAPTERS)
      for (const schema of chapter.schemas ?? []) {
        // A facet store's answer gets a schema only once the command store is built.
        if (/facet/.test(schema.name))
          expect(schema.name).toBe("steward-facet");
        if (/takeover|launch-claim|merge-ready/.test(schema.name))
          expect(chapter.id).toBe("forge-claims");
        if (/^steward-/.test(schema.name))
          expect(chapter.id).toBe("steward-records");
      }
    expect(
      (CHAPTERS.find((c) => c.id === "forge-claims")?.schemas ?? []).map(
        (s) => s.name,
      ),
    ).toEqual([
      "drive-takeover-claim",
      "dispatch-launch-claim",
      "drive-merge-ready",
    ]);
  });
});

describe("stable JSON writers", () => {
  test("legacy version-1 follow-up records may omit pr and ignore its unusable value", () => {
    for (const result of [false, true]) {
      for (const extra of [{}, { pr: "ignored legacy telemetry" }]) {
        const body = `<!-- jig-dispatch-followup -->\n${encodeMarker("jig-dispatch-followup-data", { kind: "dispatch-followup", v: 1, key: "9", writer, at }, { run: "tick", record: "20261104T093000Z-aaaaaaaa", ...(result ? { outcome: "done" } : {}), ...extra })}`;
        const value = markerJson(body, "jig-dispatch-followup-data");
        expect(
          readClaim(FOLLOWUP_CLAIM, body, { repo: "example/repo", number: 9 }),
        ).toMatchObject({
          ok: true,
          value: { legacy: true },
        });
        expectSchemaAccepts(published("followup-claim"), value);
        if (result) expectSchemaAccepts(published("followup-result"), value);
      }
    }
    const current = markerJson(
      claimBody(
        FOLLOWUP_CLAIM,
        tickClaim("20261104T093000Z-aaaaaaaa", { pr: 9, writer, at }),
      ),
      "jig-dispatch-followup-data",
    );
    const { pr: _pr, ...missingPr } = current;
    expectSchemaRejects(published("followup-claim"), missingPr);
    expectSchemaRejects(published("followup-result"), {
      ...missingPr,
      outcome: "done",
    });
  });
  test("the generic envelope publication leaves each kind's own constraints to its chapter", () => {
    const schema = published("record-envelope");
    expect(schema).toMatchObject({
      type: "object",
      properties: { kind: { type: "string" } },
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /drive-takeover-claim|dispatch-launch-claim|merge-ready/,
    );
  });
  test("ledger writer and earlier ledger payloads fit the same published schema", () => {
    const ledger = ledgerFromState(freshState(12), {
      generation: 1,
      driver: {
        actor: "tree",
        clone: "clone",
        heartbeat: at,
        state: "running",
      },
      narrative: [],
      claims: [],
    });
    const rendered = renderLedger(ledger);
    if (!("body" in rendered)) throw new Error("ledger did not render");
    expectSchemaAccepts(
      published("drive-ledger"),
      markerJson(rendered.body, "drive-pr-ledger-data"),
    );
    expectSchemaAccepts(published("drive-ledger"), ledger);
    expect(parseLedger(rendered.body)?.kind).toBe("ledger");
    expectSchemaRejects(published("drive-ledger"), {
      ...ledger,
      narrative: [42],
    });
  });
  test("both attachment writers fit their marker schema", () => {
    const file = {
      title: "Example",
      filename: "example.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    };
    for (const body of [
      carriedBody(file, "hello"),
      linkBody(file, "https://example.test/file"),
    ]) {
      expectSchemaAccepts(published("tracker-attachment"), markerOf(body));
    }
    expectSchemaRejects(published("tracker-attachment"), {
      form: "link",
      filename: 12,
      title: "Example",
    });
  });
  test("the reflection store writer's fenced records fit both publications", () => {
    const event = sampleFinding(newId("2026-01-01T00:00:00Z"), "A finding");
    const comments = commentsFor(
      [{ event, text: eventText(event) }],
      "2026-01-01T00:00:00Z",
    );
    for (const comment of comments)
      for (const text of recordsIn(comment.body) ?? []) {
        expectSchemaAccepts(published("reflection-record"), JSON.parse(text));
        expectSchemaAccepts(published("reflection-event"), JSON.parse(text));
      }
  });
  test("mailbox writers emit schema-valid inbox and outbox lines", async () => {
    const dir = tempDir("mailbox-writers");
    const note = await appendNote(dir, "12", "sender", "hello");
    await appendDirective(dir, "12", "sender", "stop", {
      generation: 1,
      now: true,
    });
    await appendDirective(dir, "12", "sender", "resume", { target: "stop" });
    for (const line of readFileSync(inboxPath(dir), "utf8").trim().split("\n"))
      expectSchemaAccepts(published("mailbox-message"), JSON.parse(line));
    await appendOutboxRecord(dir, {
      id: note.id,
      ts: note.ts,
      pr: note.pr,
      status: "received",
    });
    for (const line of readFileSync(outboxPath(dir), "utf8").trim().split("\n"))
      expectSchemaAccepts(published("mailbox-outbox"), JSON.parse(line));
  });
  test("envelope codec, claim markers and sent answers round-trip through their schemas", () => {
    const data = markerJson(
      encodeMarker(
        "jig-send-answer",
        { kind: "drive-answer", v: 1, key: "answer:question", writer, at },
        { pr: 12 },
      ),
      "jig-send-answer",
    );
    expectSchemaAccepts(published("record-envelope"), data);
    expectSchemaRejects(published("record-envelope"), {
      ...data,
      writer: { host: "" },
    });
    for (const [name, marker, body] of [
      [
        "tracker-claim-marker",
        "jig-claim-data",
        claimMarkerBody({
          at,
          attempt: "attempt",
          session: "session",
          branch: "branch",
          claimant: "example",
        }),
      ],
      [
        "tracker-claim-outcome",
        "jig-claim-outcome",
        claimOutcomeBody({ at, attempt: "attempt", outcome: "released" }),
      ],
      [
        "drive-answer",
        "jig-send-answer",
        answerComment("question", "Continue", 12, writer, at),
      ],
    ]) {
      const json = markerJson(body as string, marker as string);
      expectSchemaAccepts(published(name as string), json);
      expectSchemaRejects(published(name as string), { ...json, v: 999 });
    }
  });
  test("tick, manual and completed follow-up claims fit their published forms", () => {
    for (const draft of [
      tickClaim("20260101T000000Z-01234567", { pr: 12, writer, at }),
      manualClaim(false, { pr: 12, writer, at }),
      manualClaim(true, { pr: 12, writer, at }),
    ]) {
      const json = markerJson(
        claimBody(FOLLOWUP_CLAIM, draft),
        "jig-dispatch-followup-data",
      );
      expectSchemaAccepts(published("followup-claim"), json);
      if (json.outcome === "done")
        expectSchemaAccepts(published("followup-result"), json);
      expectSchemaRejects(published("followup-claim"), {
        ...json,
        run: "unknown",
      });
    }
  });
  test("mailbox reader accepts the schema's legacy optional-field variants", () => {
    const candidates = [
      {
        id: "note",
        kind: "note",
        ts: at,
        from: "sender",
        pr: "12",
        body: "hello",
      },
      {
        id: "stop",
        kind: "directive",
        ts: at,
        from: "sender",
        pr: "12",
        command: "stop",
      },
    ];
    for (const message of candidates) {
      expectSchemaAccepts(published("mailbox-message"), message);
      expect(parseInboxMessage(message)).not.toBeNull();
      expectSchemaRejects(published("mailbox-message"), {
        ...message,
        kind: "future",
      });
    }
  });
});

describe("the forge claims' writers", () => {
  /** A record's JSON fits its schema exactly when its reader reads the comment. */
  function agree(
    name: string,
    kind: typeof LAUNCH_CLAIM,
    body: string,
    reads: boolean,
  ) {
    const json = markerJson(body, kind.data.slice("<!-- ".length));
    const read = readClaim(kind, body, { repo: "example/repo", number: 12 });
    expect(read?.ok ?? false).toBe(reads);
    if (reads) expectSchemaAccepts(published(name), json);
    else expectSchemaRejects(published(name), json);
  }
  const record = "20260101T000000Z-01234567";
  const draft: LaunchDraft = {
    stage: "drive",
    pr: 12,
    run: "tick",
    action: "rearm",
    record,
    host: "sha256:aaaaaaaaaaaaaaaa",
    owner: true,
    facts: "generation 3, exit 16",
    writer,
  };

  test("takeover claims, in the envelope and in the form before it, fit the takeover schema", () => {
    const body = renderClaim(
      { actor: "wt-bbbbbbbbbbbbbbbb", clone: "clone-b", generation: 4, at },
      writer,
    );
    agree("drive-takeover-claim", TAKEOVER_CLAIM, body, true);
    agree(
      "drive-takeover-claim",
      TAKEOVER_CLAIM,
      body.replace('"actor":"wt-bbbbbbbbbbbbbbbb"', '"actor":5'),
      false,
    );
    const legacy = {
      actor: "wt-cccccccccccccccc",
      clone: "clone-c",
      generation: 4,
      at: "2026-10-01T12:00:00.000Z",
    };
    expectSchemaAccepts(published("drive-takeover-claim"), legacy);
    expectSchemaRejects(published("drive-takeover-claim"), {
      ...legacy,
      generation: -1,
    });
    // A record that names its kind is read as one in the envelope, never as the older form.
    expectSchemaRejects(published("drive-takeover-claim"), {
      ...legacy,
      kind: "drive-takeover-claim",
    });
  });

  test("launch claims, posted and with each end, fit the launch schema", () => {
    const posted = launchClaim(
      {
        ...draft,
        change: "head abc",
        earlier: ["head 123"],
        conflictStop: true,
      },
      2,
      at,
    );
    const claim = {
      key: posted.key,
      generation: 2,
      at,
      writer,
      payload: posted.payload,
      legacy: false,
    };
    for (const d of [
      launchClaim(draft, 1, at),
      launchClaim(
        { ...draft, action: "takeover", owner: null, facts: null },
        1,
        at,
      ),
      posted,
      endedClaim(
        "drive",
        claim,
        12,
        { state: "ended", at, exit: 16, outcome: null },
        writer,
      ),
      endedClaim(
        "drive",
        claim,
        12,
        {
          state: "ended",
          at,
          exit: null,
          outcome: null,
          by: "agent",
          cause: "needs-person",
        },
        writer,
      ),
      endedClaim(
        "drive",
        claim,
        12,
        { state: "died", at, reason: "gone", executed: false },
        writer,
      ),
    ]) {
      const body = claimBody(LAUNCH_CLAIM, d);
      agree("dispatch-launch-claim", LAUNCH_CLAIM, body, true);
      const json = markerJson(body, "jig-dispatch-launch-claim-data");
      for (const broken of [
        { ...json, action: "arm" },
        { ...json, host: "" },
        { ...json, end: { state: "running", at } },
        { ...json, generation: 0 },
      ])
        expectSchemaRejects(published("dispatch-launch-claim"), broken);
      const { pr: _pr, ...noPr } = json;
      expectSchemaRejects(published("dispatch-launch-claim"), noPr);
    }
  });

  test("a merge-ready announcement fits the merge-ready schema", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const body = claimBody(
      MERGE_READY,
      announcementDraft(head, `done\n\n${headMarker(head)}`, writer),
    );
    agree("drive-merge-ready", MERGE_READY, body, true);
    const json = markerJson(body, "drive-pr-merge-ready-data");
    expectSchemaRejects(published("drive-merge-ready"), {
      ...json,
      key: "merge-ready:not-a-head",
    });
  });
});

describe("the rule schema", () => {
  test("accepts what the rule matcher reads as a rule, and refuses what it refuses", () => {
    const at = "pull_requests.base_rules[0].when";
    for (const rule of [{ labels: ["hotfix"] }, { labels: ["a", "b"] }]) {
      expectSchemaAccepts(published("rule"), rule);
      expect(parseRule("pull_requests.base_rules", rule, at).ok).toBe(true);
    }
    for (const rule of [
      { colour: ["red"] },
      { labels: [] },
      { labels: "x" },
      {},
      { labels: [" "] },
    ]) {
      expectSchemaRejects(published("rule"), rule);
      expect(parseRule("pull_requests.base_rules", rule, at).ok).toBe(false);
    }
  });
});

describe("the decision record's writers", () => {
  const FACTS: StationFacts[] = [
    {
      kind: "followup-failed",
      pr: 12,
      record: null,
      marker: 3,
      question: null,
    },
    {
      kind: "followup-failed",
      pr: 12,
      record: "20260101T000000Z-01234567",
      marker: null,
      question: "Which branch?",
    },
    { kind: "followup-stale", pr: 12, marker: 3, released: 2 },
    { kind: "stalled", item: "ENG-1", state: "In Progress", carriedBy: [] },
    {
      kind: "pickup-question",
      item: "ENG-1",
      record: "20260101T000000Z-01234567",
      question: "Which scope?",
    },
    {
      kind: "pickup-ended",
      item: "ENG-1",
      record: "20260101T000000Z-01234567",
      ended: null,
      carriedBy: null,
    },
    { kind: "checkout", target: "#12", branch: "b", path: "/tmp/x" },
    { kind: "drive", pr: 12, exit: "6", started: null, failedRearm: null },
    { kind: "launch", target: "#12", record: "20260101T000000Z-01234567" },
  ];
  const written = [
    ...FACTS.map((f) => frameStationDecision(f).decision),
    advisoryDecision(["sonar"]),
    cancelledCiDecision("the run was cancelled twice"),
  ];

  test("every record a writer writes fits the schema, passes the strict check and reads", () => {
    for (const decision of written) {
      const json = JSON.parse(JSON.stringify(decision));
      expectSchemaAccepts(published("parked-decision"), json);
      expect(isParkedDecision(json)).toBe(true);
      expect(checkParkedDecision(json, json.class)).toEqual([]);
    }
  });

  test("the schema refuses exactly what the stored reader refuses", () => {
    const [base] = written;
    const json = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    const call = json.call as Record<string, unknown>;
    const options = call.options as Record<string, unknown>[];
    const variants: unknown[] = [
      json,
      { ...json, later: 1 },
      { ...json, sheet: "https://example.test/s" },
      { ...json, facts: [{ text: "t", source: "s" }] },
      { ...json, interplay: [{ from: "a", to: "b", text: "t" }] },
      { ...json, call: { ...call, options: [{ ...options[0], keep: [] }] } },
      { ...json, schema: "parked-decision/v2" },
      { ...json, class: 1 },
      { ...json, steps: [1] },
      { ...json, sheet: null },
      { ...json, facts: [{ text: "t" }] },
      { ...json, interplay: [{ from: "a", to: "b" }] },
      { ...json, call: { ...call, why: null } },
      { ...json, call: { ...call, options: [{ ...options[0], pay: "x" }] } },
      {
        ...json,
        call: { ...call, options: [{ ...options[0], reversible: "no" }] },
      },
      [json],
      null,
    ];
    for (const value of variants)
      if (isParkedDecision(value))
        expectSchemaAccepts(published("parked-decision"), value);
      else expectSchemaRejects(published("parked-decision"), value);
  });
});

describe("the steward's records", () => {
  const launch = "20261101T000000Z-0123abcd";
  const reason = "the evidence shows it";
  const records = [
    {
      kind: "rearm",
      target: "PR #12",
      facts: "recovery: generation 3, exit 16",
      class: "network timeout",
      reason,
    },
    { kind: "resume", record: launch, reason },
    {
      kind: "need",
      target: "PR #12",
      act: "Decide",
      ask: "Choose the endpoint.",
      reason,
    },
    {
      kind: "facet",
      target: "#34",
      facet: "priority",
      value: 2,
      reason,
    },
    { kind: "facet", target: "#34", facet: "size", value: "S", reason },
    { kind: "order", targets: ["#34", "#35"], reason },
    {
      kind: "cause",
      record: launch,
      cause: "crashed",
      summary: "Wrote the migration; the transcript stops mid-test.",
      reason,
    },
  ] as const;

  /** A record fits its kind's schema, and a submission of it the submission's, exactly when the reader reads it. */
  function agree(record: Record<string, unknown>, reads: boolean) {
    expect(checkedRecords([record]).ok).toBe(reads);
    const schema = published(`steward-${String(record.kind)}`);
    if (reads) {
      expectSchemaAccepts(schema, record);
      expectSchemaAccepts(published("steward-submission"), [record]);
    } else {
      expectSchemaRejects(published("steward-submission"), [record]);
      expectSchemaRejects(schema, record);
    }
  }

  test("every record the reader reads fits its kind's schema and the submission's", () => {
    for (const record of records) agree(record, true);
    expectSchemaAccepts(published("steward-submission"), [...records]);
    expectSchemaAccepts(published("steward-submission"), []);
  });

  test("a record the reader refuses for its shape fits neither", () => {
    const [rearm, resume, need, priority, size, order, cause] = records;
    for (const record of [
      { ...rearm, target: "PR #0" },
      { ...rearm, model: "a model" },
      { ...rearm, reason: " " },
      { ...resume, record: "" },
      { ...need, act: "Approve" },
      { ...priority, value: 5 },
      { ...priority, value: "2" },
      { ...size, value: "v".repeat(101) },
      { ...size, facet: "estimate" },
      { ...order, targets: "#34" },
      { ...cause, cause: "deadline" },
      { ...cause, summary: "s".repeat(601) },
    ])
      agree(record, false);
    expectSchemaRejects(
      published("steward-submission"),
      Array.from({ length: 101 }, () => resume),
    );
  });
});
