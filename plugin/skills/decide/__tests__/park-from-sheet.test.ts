import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parkFromSheet } from "../scripts/decision-sheet/park.ts";
import type { Call, DecisionSource } from "../scripts/decision-sheet/source.ts";

const source = (): Omit<DecisionSource, "calls"> & { calls: [Call] } => ({
  schema: "decision-sheet/v1",
  id: "decision",
  url: "https://example.com/decision",
  title: "Choose the transport",
  owners: ["technical"],
  priority: "High",
  reversibility: "The transport can be changed later.",
  verifiedAt: { date: "2026-11-10", commit: "1234567" },
  question: "Which transport\nshould carry the events?",
  currentBehaviour: [
    { text: "The transport is {opt:1}.", source: "transport.ts" },
  ],
  calls: [
    {
      id: "b",
      options: [
        {
          id: "1",
          name: "Queue",
          summary: "Use a queue instead of {opt:2}.",
          pay: ["Operate the queue."],
          keep: ["Keep delivery."],
          rightWhen: "Delivery must outlive the request.",
          outcomes: {},
        },
        {
          id: "2",
          name: "Direct",
          summary: "Call the receiver.",
          pay: ["Retry failures."],
          keep: [],
          rightWhen: "The receiver is always present.",
        },
      ],
      recommended: "1",
      why: "Prefer {opt:1} for durable delivery.",
      facts: [{ text: "{opt:1} survives a restart.", source: "queue.ts" }],
    },
  ],
  myRead: "Choose the durable transport.",
});

describe("parking a sheet call", () => {
  it("fills the question, expands references and leaves sheet-only fields behind", () => {
    const input = source();
    const result = parkFromSheet(input, "b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      schema: "parked-decision/v1",
      class: "escalated",
      sheet: input.url,
      steps: [],
      call: {
        id: "a",
        question: "Which transport should carry the events?",
        recommended: "1",
        why: "Prefer option 1 for durable delivery.",
      },
      facts: [{ text: "option 1 survives a restart.", source: "queue.ts" }],
    });
    expect(result.value.call.options[0]?.summary).toBe(
      "Use a queue instead of option 2.",
    );
    expect(result.value.call.options[0]).not.toHaveProperty("outcomes");
    expect(result.value.call).not.toHaveProperty("facts");
    expect(result.value.alreadyDone).toContain("1234567");
    expect(input.calls[0]?.options[0]?.summary).toContain("{opt:2}");
  });

  it("prefers the call question and accepts explicit park context", () => {
    const input = source();
    input.calls[0].question = "Should {opt:1} be deployed?";
    const result = parkFromSheet(input, "b", {
      class: "release",
      steps: ["Approve {call:b,opt:1}."],
      alreadyDone: "Built {call:b,opt:1} and ran its checks.",
      sheet: "https://example.com/sheet.html",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.call.question).toBe("Should option 1 be deployed?");
    expect(result.value.class).toBe("release");
    expect(result.value.steps).toEqual(["Approve (b) option 1."]);
    expect(result.value.alreadyDone).toBe(
      "Built (b) option 1 and ran its checks.",
    );
  });

  it("refuses a call with no recommendation or one that does not exist", () => {
    const input = source();
    delete input.calls[0].recommended;
    const result = parkFromSheet(input, "b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toContain("recommendation");
    const absent = parkFromSheet(input, "absent");
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.failure.reason).toContain("absent");
  });

  it("normalizes a descriptive question and carries interplay in words", () => {
    const input = source();
    input.question = "Choose the transport.\nKeep delivery durable.!!!";
    input.interplay = [
      { from: "b", to: "external", text: "{call:b,opt:1} needs the receiver." },
    ];
    const result = parkFromSheet(input, "b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.call.question).toBe(
      "Choose the transport. Keep delivery durable?",
    );
    expect(result.value.interplay?.[0]?.text).toBe(
      "(b) option 1 needs the receiver.",
    );
  });

  it("refuses a recommendation missing from the options instead of emitting an invalid park", () => {
    const input = source();
    input.calls[0].recommended = "missing";
    const result = parkFromSheet(input, "b");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.failure.reason).toContain("$.call.recommended");
  });

  it("exports a checked park through the sheet command", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/decision-sheet/decision-sheet.ts"),
        "park",
        join(import.meta.dir, "fixtures/decision-sheet/edge-cases.json"),
        "--call",
        "a",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(result, 0);
    const decision = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(decision.schema).toBe("parked-decision/v1");
    expect(decision.call.recommended).toBeDefined();
    expect(JSON.stringify(decision)).not.toContain("{opt:");
    expect(decision.call.options[0]).not.toHaveProperty("outcomes");
  });
});
