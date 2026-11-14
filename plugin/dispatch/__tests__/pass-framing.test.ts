/**
 * A dispatched pickup's or follow-up's pass that stops for a person is told
 * to frame the decision it asks for and record it with its result, under
 * its own record's token, keeping the `Question:` line that ends its output.
 */
import { describe, expect, it } from "bun:test";
import type { LaunchRecord } from "../lib/launches.ts";
import {
  followupPassArgv,
  pickupPassArgv,
  stewardPassArgv,
} from "../lib/session.ts";

const record = {
  id: "20261110T000000Z-00000000",
  token: "0".repeat(32),
  action: "pickup",
  repo: "owner/repo",
  pr: 12,
  item: "#1",
  marker: 41,
  command: "/followup",
  vendor: "claude",
  model: null,
  effort: null,
  sessionId: null,
} as unknown as LaunchRecord;

describe("a pass's prompt", () => {
  for (const [name, argv] of [
    ["pickup", pickupPassArgv(record, [])],
    ["follow-up", followupPassArgv({ ...record, action: "followup" }, [])],
  ] as const) {
    it(`${name}: frames a stop for a person and records it with the result`, () => {
      const prompt = argv.at(-1) ?? "";
      expect(prompt).toContain('"schema":"parked-decision/v1"');
      expect(prompt).toContain(
        `dispatch result ${record.id} ${record.token} failed --decision <that file>`,
      );
      expect(prompt).toContain(
        'end your output with one line that starts "Question:"',
      );
      expect(prompt).toContain("record failed without --decision");
    });
  }
});

describe("a pass's closing report", () => {
  for (const [name, argv] of [
    ["pickup", pickupPassArgv(record, [])],
    ["follow-up", followupPassArgv({ ...record, action: "followup" }, [])],
    [
      "steward",
      stewardPassArgv(
        { ...record, action: "steward", item: null, pr: null },
        [],
      ),
    ],
  ] as const) {
    it(`${name}: asks for the report as its last act, under its record's token`, () => {
      const prompt = argv.at(-1) ?? "";
      const lines = prompt.split("\n");
      expect(lines.at(-1)).toStartWith("As your last act");
      expect(prompt).toContain('"schema":"closing-report/v1"');
      expect(prompt).toContain(
        `dispatch report ${record.id} ${record.token} <that file>`,
      );
      expect(prompt).toContain("needs-person, refused, tool-failed");
      expect(prompt).toContain(
        "Merge, Decide, Authorize, Reply, Do, Investigate",
      );
      expect(prompt).toContain("pr:#<number>, commit:<sha>");
    });
  }

  it("pickup: records its result once the drive is armed and goes on, the report at the end", () => {
    const prompt = pickupPassArgv(record, []).at(-1) ?? "";
    expect(prompt).toContain(
      "record this as soon as the drive is armed, then go on",
    );
    expect(prompt.indexOf("dispatch result")).toBeLessThan(
      prompt.indexOf("dispatch report"),
    );
  });
});

describe("a pass's background work", () => {
  for (const [name, argv] of [
    ["pickup", pickupPassArgv(record, [])],
    ["follow-up", followupPassArgv({ ...record, action: "followup" }, [])],
    [
      "steward",
      stewardPassArgv(
        { ...record, action: "steward", item: null, pr: null },
        [],
      ),
    ],
  ] as const) {
    it(`${name}: keeps long steps in the foreground and bounds a wait on another agent`, () => {
      const prompt = argv.at(-1) ?? "";
      expect(prompt).toContain("This pass has no next turn");
      expect(prompt).toContain("in the foreground");
      expect(prompt).toContain("bound the wait");
    });
  }

  it("pickup: pushes committed work before a long validation step", () => {
    const prompt = pickupPassArgv(record, []).at(-1) ?? "";
    expect(prompt).toContain("push the branch before a long validation step");
  });
});
