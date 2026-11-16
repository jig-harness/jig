import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { matches, toJsonSchema } from "../../../shared/shapes.ts";
import { REFLECTION_EVENT_SHAPE } from "../scripts/lib/event-shapes.ts";
import { eventText, newId, parseEvent } from "../scripts/lib/events.ts";
import { sampleFinding } from "../scripts/store-contract.ts";

describe("reflection event output shape", () => {
  const validate = new Ajv2020({ strict: false }).compile(
    toJsonSchema(REFLECTION_EVENT_SHAPE),
  );
  test("the event writer and reader round trip through its schema", () => {
    const finding = sampleFinding(newId("2026-11-15T08:00:00Z"), "A finding");
    const events = [
      finding,
      {
        v: 1 as const,
        type: "decision" as const,
        id: newId("2026-11-15T08:00:01Z"),
        at: "2026-11-15T08:00:01Z",
        session: finding.session,
        finding: finding.id,
        decision: "escalated" as const,
        reason: "Needs review",
        issue: "#1",
      },
    ];
    for (const event of events) {
      const output = JSON.parse(eventText(event));
      expect(validate(output)).toBe(true);
      expect(matches(REFLECTION_EVENT_SHAPE, output)).toBe(true);
      expect(parseEvent(eventText(event))).toEqual(event);
    }
  });
  test("the schema and reader refuse the same malformed fields", () => {
    const event = sampleFinding(newId(), "A finding");
    for (const invalid of [
      { ...event, v: 2 },
      { ...event, severity: "urgent" },
      { ...event, time_cost_minutes: -1 },
      { ...event, session: { ...event.session, skills: [null] } },
    ]) {
      expect(validate(invalid)).toBe(false);
      expect(matches(REFLECTION_EVENT_SHAPE, invalid)).toBe(false);
      expect(() => parseEvent(JSON.stringify(invalid))).toThrow();
    }
  });
});
