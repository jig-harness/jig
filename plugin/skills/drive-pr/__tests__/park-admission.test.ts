import { expect, test } from "bun:test";
import { parkAdmissionProblem } from "../scripts/lib/state/park-admission.ts";
import { freshState, isUsableState } from "../scripts/lib/state/schema.ts";
import { redactStrings } from "../scripts/lib/state/ledger.ts";
import type { ParkedDecision } from "../../../shared/decisions/park.ts";
import { parkRecord } from "./park-record-fixture.ts";

test("admission refuses UTF-8 decision bytes and aggregate ledger overflow", () => {
  const decision = JSON.parse(parkRecord("Keep it?")) as ParkedDecision;
  const state = freshState(999);
  expect(parkAdmissionProblem(state, decision)).toBeNull();
  const oversized = { ...decision, alreadyDone: "界".repeat(3000) };
  const error = parkAdmissionProblem(state, oversized);
  expect(error).toContain("8192");
  expect(error).toContain(
    String(new TextEncoder().encode(JSON.stringify(oversized)).length),
  );
  const small = { ...decision, alreadyDone: "界".repeat(1500) };
  state.parked = Array.from({ length: 15 }, (_, i) => ({
    key: String(i),
    kind: "finding",
    reason: small.call.question,
    class: small.class,
    decision: small,
    round: 0,
  }));
  const full = parkAdmissionProblem(state, small);
  expect(full).toContain("65536");
  expect(full).toContain("decision is");
  expect(full).toContain("alone need");
});

test("redaction preserves JSON shape, tolerant reads and legacy state", () => {
  const decision = JSON.parse(
    parkRecord("Ask person@example.test?"),
  ) as ParkedDecision;
  decision.call.options = decision.call.options.map((option, index) => ({
    ...option,
    name: index === 0 ? "person@example.test" : "another@example.test",
    reversible: false,
  }));
  const redacted = redactStrings(decision);
  expect(redacted.call.options[1]?.reversible).toBe(false);
  expect(redacted.call.options.map((o) => o.name)).toEqual([
    "<redacted>",
    "<redacted>",
  ]);
  const state = freshState(999);
  state.parked.push({
    key: "a",
    kind: "finding",
    reason: "Ask?",
    round: 0,
    decision: redacted,
  });
  expect(isUsableState(state, 999)).toBe(true);
  state.parked.push({
    key: "b",
    kind: "finding",
    reason: "Old?",
    round: 0,
    record: "## Question\nOld?",
  });
  expect(isUsableState(state, 999)).toBe(true);
});

test("foreign effective claims participate in near-limit admission", () => {
  const decision = JSON.parse(parkRecord("Keep it?")) as ParkedDecision;
  const state = freshState(999);
  const park = {
    key: "a",
    kind: "finding" as const,
    reason: "Question?",
    round: 0,
    decision,
  };
  state.parked = [park];
  let fits = 0;
  let refuses = 65536;
  while (refuses - fits > 1) {
    const size = Math.floor((fits + refuses) / 2);
    park.reason = "x ".repeat(size);
    if (parkAdmissionProblem(state, decision) === null) fits = size;
    else refuses = size;
  }
  park.reason = "x ".repeat(Math.max(0, fits - 100));
  expect(parkAdmissionProblem(state, decision)).toBeNull();
  expect(
    parkAdmissionProblem(state, decision, {
      generation: 99,
      claims: Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        clone: "clone-0123456789abcdef",
        generation: i,
      })),
    }),
  ).toContain("65536");
});
