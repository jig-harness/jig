import { describe, expect, test } from "bun:test";
import { passOutput, stewardNoSubmitCause } from "../lib/pass-output.ts";

describe("a headless pass's retained evidence", () => {
  test("keeps a bounded output tail without requiring a question, including a submitted pass", () => {
    const output = `${"x".repeat(9000)}\nfailed to read digest`;
    expect(passOutput({ output }, null, "secret")).toEqual({
      context: output.slice(-8000),
    });
    expect(
      passOutput(
        { output: "submitted", said: "Question: old" },
        "done",
        "secret",
      ),
    ).toEqual({ context: "submitted" });
  });

  test("redacts the launch token and preserves a question independently of output", () => {
    expect(
      passOutput(
        { output: "token=secret", said: "Question: retry secret?" },
        null,
        "secret",
      ),
    ).toEqual({
      context: "token=[launch token]",
      said: "Question: retry [launch token]?",
    });
    expect(passOutput({}, null, "secret")).toEqual({});
  });
});

describe("a steward end without submitting", () => {
  test.each([
    [
      "This skill can only be invoked by Claude, not directly by users.",
      "output reports a refused skill invocation",
    ],
    [
      "You've hit your weekly limit · resets Nov 20",
      "output reports a vendor usage limit",
    ],
    [
      "error: Cannot find config file '/cache/dispatch/bunfig.toml'",
      "output reports missing installed runtime configuration",
    ],
    ["normal final prose", "unknown; inspect the retained output tail"],
    ["", "unknown; no output was retained"],
  ])(
    "names an observed cause without copying output into the outcome log: %s",
    (output, cause) => {
      expect(stewardNoSubmitCause(output)).toBe(cause);
    },
  );
});
