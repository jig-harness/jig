/**
 * A dispatched pickup's or follow-up's pass that stops for a person is told
 * to frame the decision it asks for and record it with its result, under
 * its own record's token, keeping the `Question:` line that ends its output.
 */
import { describe, expect, it } from "bun:test";
import type { LaunchRecord } from "../lib/launches.ts";
import { followupPassArgv, pickupPassArgv } from "../lib/session.ts";

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
