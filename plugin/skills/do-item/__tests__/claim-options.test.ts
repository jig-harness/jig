/** `tracker.ts claim`'s options, and where a person's `--override-blockers` is refused. */
import { describe, expect, it } from "bun:test";
import {
  claimOptions,
  normalizeClaimOptions,
} from "../scripts/lib/claim-options.ts";

const NO_LAUNCH = {};
const parse = (args: string[], env: Record<string, string> = NO_LAUNCH) => {
  const rest = [...args];
  normalizeClaimOptions(rest);
  return claimOptions(new Set(rest), env);
};

describe("claimOptions", () => {
  it("reads each valued option, in either form", () => {
    expect(parse(["--for", "dana", "--ancestor=#1"])).toMatchObject({
      person: "dana",
      ancestor: "#1",
    });
    expect(
      parse(["--override-blockers", "a reason with spaces"]),
    ).toMatchObject({ overrideBlockers: "a reason with spaces" });
  });

  it("refuses the served and factory combinations it refused before", () => {
    expect(() => parse(["--ancestor", "#1"])).toThrow("require --for");
    expect(() => parse(["--for", "dana", "--factory-ancestor", "#1"])).toThrow(
      "cannot be combined with served claim options",
    );
    expect(() => parse(["--for=a", "--for=b"])).toThrow("duplicate");
  });

  it("takes --override-blockers only in an interactive person's plain claim", () => {
    const reason = ["--override-blockers", "decided"];
    expect(parse(reason).overrideBlockers).toBe("decided");
    expect(() => parse(reason, { JIG_LAUNCH: "launch-1" })).toThrow(
      "JIG_LAUNCH",
    );
    expect(parse(reason, { JIG_LAUNCH: "  " }).overrideBlockers).toBe(
      "decided",
    );
    for (const extra of [
      ["--for", "dana"],
      ["--factory-ancestor", "#1"],
    ])
      expect(() => parse([...reason, ...extra])).toThrow(
        "served or factory claim",
      );
    expect(() => parse([...reason, "--work-batch"])).toThrow("work-batch");
  });

  it("refuses a missing, empty or blank reason", () => {
    for (const args of [
      ["--override-blockers"],
      ["--override-blockers", ""],
      ["--override-blockers", "--work-batch"],
      ["--override-blockers", " \t "],
      ["--override-blockers= "],
    ])
      expect(() => parse(args)).toThrow(
        "--override-blockers requires a reason",
      );
  });

  it("refuses a reason that becomes empty when displayed", () => {
    expect(() => parse(["--override-blockers", "\u0007"])).toThrow(
      "--override-blockers requires a reason",
    );
  });
});
