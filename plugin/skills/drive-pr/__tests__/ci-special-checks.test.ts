import { expect, test } from "bun:test";
import {
  specialCiSettings,
  classifyFailures,
  advisoryDecision,
  sentinelNames,
} from "../scripts/lib/ci-special-checks.ts";

test("held sentinels wait only while the hold is live", () => {
  expect(classifyFailures(["held", "test"], ["held"], [], true)).toEqual({
    held: ["held"],
    advisory: [],
    repair: ["test"],
  });
  expect(classifyFailures(["held"], ["held"], [], false).repair).toEqual([
    "held",
  ]);
});
test("advisory-only failures park; mixed failures retain actionable checks", () => {
  expect(classifyFailures(["scan"], [], ["scan"], false)).toEqual({
    held: [],
    advisory: ["scan"],
    repair: [],
  });
  expect(
    classifyFailures(["scan", "test"], [], ["scan"], false).repair,
  ).toEqual(["test"]);
});
test("policy defaults and malformed values", () => {
  expect(specialCiSettings({})).toEqual({
    holdSentinels: [],
    advisoryChecks: [],
  });
  expect(() => specialCiSettings({ ci: { hold_sentinels: "gate" } })).toThrow(
    "ci.hold_sentinels",
  );
  expect(() => specialCiSettings({ ci: { advisory_checks: [""] } })).toThrow(
    "ci.advisory_checks",
  );
});
test("M13 sentinel shape detects exact job names and rejects tolerated failures", () => {
  const wf = {
    jobs: {
      gate: {
        name: "Gate",
        if: "!cancelled()",
        steps: [
          {
            if: "contains(github.event.pull_request.labels.*.name, 'ci:hold')",
            run: "exit 1",
          },
        ],
      },
      ignored: {
        "continue-on-error": true,
        steps: [
          {
            if: "contains(github.event.pull_request.labels.*.name, 'ci:hold')",
            run: "exit 1",
          },
        ],
      },
    },
  };
  expect(sentinelNames(wf, "ci:hold")).toEqual(["Gate"]);
});
test("advisory decision has the three human choices", () => {
  const d = advisoryDecision(["scan"]);
  expect(d.class).toBe("reviewer-posture");
  expect(d.call.options.map((o) => o.name)).toEqual([
    "Fix the finding",
    "Waive it",
    "Leave it to me",
  ]);
});

test("a benign conditional step does not prove a held sentinel", () => {
  expect(
    sentinelNames(
      {
        jobs: {
          gate: {
            steps: [
              {
                if: "contains(github.event.pull_request.labels.*.name, 'ci:hold')",
                run: "echo held",
              },
            ],
          },
        },
      },
      "ci:hold",
    ),
  ).toEqual([]);
});

test("a conditional exit followed by success is not a held sentinel", () => {
  expect(
    sentinelNames(
      {
        jobs: {
          gate: {
            steps: [
              {
                if: "contains(github.event.pull_request.labels.*.name, 'ci:hold')",
                run: "if test -f flag; then\n exit 1\nfi\nexit 0",
              },
            ],
          },
        },
      },
      "ci:hold",
    ),
  ).toEqual([]);
});
