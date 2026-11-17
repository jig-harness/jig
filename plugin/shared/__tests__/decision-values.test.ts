/**
 * The tables of a decision and its answers (`decisions/decision-values.ts`,
 * `acts.ts`, `decisions/station.ts`) hold what the code reads: each field
 * the decision record's table lists is a field of its shape at that path,
 * carried always exactly where the shape requires it; every decision class
 * a repository parks under by default, and every class the dispatcher
 * frames, has its act; each dispatcher framing offers the options its key's
 * entry lists; and the answer lines and forms are the ones the writers write.
 */
import { describe, expect, it } from "bun:test";
import { CLASS_ACTS } from "../acts.ts";
import { DEFAULT_PARK_CLASSES } from "../autonomy.ts";
import {
  answerLine,
  choiceInLine,
  noteLine,
  structuredAnswerText,
} from "../decision-card.ts";
import { decisionDigest } from "../decisions/digest.ts";
import {
  ANSWER_FORMS,
  ANSWER_LINES,
  DECISION_LIMITS,
  PARKED_DECISION_FIELDS,
} from "../decisions/decision-values.ts";
import { PARKED_DECISION_SHAPE } from "../decisions/park-shape.ts";
import {
  frameStationDecision,
  STATION_CLASSES,
  STATION_KEYS,
} from "../decisions/station.ts";
import type { JsonSchema } from "../shapes.ts";

type ObjectSchema = {
  type?: string;
  properties?: Record<string, ObjectSchema>;
  required?: string[];
  items?: ObjectSchema;
};

/** Every field path an object schema declares, with whether it is required and its JSON type. */
function paths(
  schema: ObjectSchema,
  prefix = "",
): Record<string, { required: boolean; type: string }> {
  const out: Record<string, { required: boolean; type: string }> = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${name}`;
    const items = field.items;
    const type =
      field.type === "array"
        ? `${items?.type ?? "unknown"}[]`
        : (field.type ??
          (typeof (field as { const?: unknown }).const === "string"
            ? "string"
            : "unknown"));
    out[path] = { required: schema.required?.includes(name) ?? false, type };
    if (field.type === "object") Object.assign(out, paths(field, `${path}.`));
    if (items?.type === "object")
      Object.assign(out, paths(items, `${path}[].`));
  }
  return out;
}

describe("the decision record's table", () => {
  const shape = paths(
    PARKED_DECISION_SHAPE.schema as JsonSchema as ObjectSchema,
  );

  it("lists exactly the shape's fields, each with its type, always carried where the shape requires it", () => {
    expect(Object.keys(PARKED_DECISION_FIELDS).sort()).toEqual(
      Object.keys(shape).sort(),
    );
    for (const [path, f] of Object.entries(PARKED_DECISION_FIELDS)) {
      const declared: {
        type: string | undefined;
        always: boolean | undefined;
      } = {
        type: f.type,
        always: f.carried === "always",
      };
      expect({ path, ...declared }).toEqual({
        path,
        type: shape[path]?.type,
        always: shape[path]?.required,
      });
    }
  });
});

describe("the acts of the decision classes", () => {
  it("names the act of every class a repository parks under by default and every class the dispatcher frames", () => {
    for (const name of [
      ...DEFAULT_PARK_CLASSES,
      ...Object.values(STATION_CLASSES),
    ])
      expect(Object.hasOwn(CLASS_ACTS, name)).toBe(true);
    for (const key of Object.values(STATION_KEYS))
      expect(CLASS_ACTS[key.class].act).toBe("Decide");
  });
});

describe("the dispatcher's framings", () => {
  it("offer the options their key lists, ending with hold, under their key's class", () => {
    for (const [key, entry] of Object.entries(STATION_KEYS)) {
      expect(entry.options.at(-1)).toBe("hold");
      expect(STATION_CLASSES[key as keyof typeof STATION_KEYS]).toBe(
        entry.class,
      );
    }
    const framed = [
      frameStationDecision({
        kind: "followup-stale",
        pr: 1,
        marker: 2,
        released: null,
      }),
      frameStationDecision({
        kind: "stalled",
        item: "ENG-1",
        state: "Todo",
        carriedBy: [],
      }),
      frameStationDecision({
        kind: "checkout",
        target: "#1",
        branch: "b",
        path: "/p",
      }),
      frameStationDecision({
        kind: "drive",
        pr: 1,
        exit: null,
        started: null,
        failedRearm: null,
      }),
      frameStationDecision({ kind: "launch", target: "#1", record: "r" }),
    ];
    expect(framed.map((f): string => f.key).sort()).toEqual(
      Object.keys(STATION_KEYS).sort(),
    );
    for (const { key, decision } of framed) {
      expect(decision.class).toBe(STATION_KEYS[key].class);
      expect(decision.call.options.map((o) => o.id)).toEqual([
        ...STATION_KEYS[key].options,
      ]);
    }
  });
});

describe("the answer lines and forms", () => {
  it("are what the writers write and the readers read", () => {
    const opening = (written: string) => written.split(" ")[0];
    expect(answerLine("k", "approve")).toBe(
      `${opening(ANSWER_LINES.answer.written)} k: approve`,
    );
    expect(noteLine("k", "only after")).toBe(
      `${opening(ANSWER_LINES.note.written)} k: only after`,
    );
    expect(
      structuredAnswerText({ option: "Keep", form: "approve" }, undefined),
    ).toBe(ANSWER_FORMS.approve.written);
    expect(
      structuredAnswerText({ option: "Keep", form: "choose" }, undefined),
    ).toBe(ANSWER_FORMS.choose.written.replace("<option>", "Keep"));
    const options = [{ name: "Keep" }, { name: "Change" }];
    const recommended = (o: { name: string }) => o.name === "Keep";
    expect(
      choiceInLine("approve [0123456789ab]", options, recommended),
    ).toEqual({
      option: { name: "Keep" },
      form: "approve",
    });
    expect(choiceInLine("choose Change", options, recommended)?.form).toBe(
      "choose",
    );
  });

  it("carry a digest of the length the limits table gives", () => {
    const { decision } = frameStationDecision({
      kind: "launch",
      target: "#1",
      record: "r",
    });
    expect(decisionDigest(decision)).toMatch(
      new RegExp(`^[0-9a-f]{${DECISION_LIMITS.digest.value}}$`),
    );
  });
});
