/** Published schemas are generated and independently validate the actual writers' JSON. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  FOLLOWUP_CLAIM,
  manualClaim,
  tickClaim,
} from "../../../plugin/shared/records/launch-claims.ts";
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
  test("accounts for every stable marker kind and publishes no provisional claim payload", () => {
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
      for (const schema of chapter.schemas ?? [])
        expect(schema.name).not.toMatch(
          /takeover|launch-claim|merge-ready|facet/,
        );
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
  test("the generic envelope publication leaves provisional kind constraints to registry readers", () => {
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
