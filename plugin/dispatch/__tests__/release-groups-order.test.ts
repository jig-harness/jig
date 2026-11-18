/** How untagged releases are ordered and which kept decisions are read back. */
import { describe, expect, it } from "bun:test";
import { releaseActions, type OwedRelease } from "../lib/release-groups.ts";

function release(tag: string, item: string, taken_as?: string): OwedRelease {
  return { tag, item, rerun_claimed: 0, taken_as: taken_as ?? null };
}

describe("release groups", () => {
  it("orders a final release after its own pre-release, whatever the tag prefix", () => {
    for (const prefix of ["v", "app-", ""]) {
      const [group] = releaseActions([
        release(`${prefix}1.0.0`, "#2"),
        release(`${prefix}1.0.0-rc.1`, "#1"),
      ]);
      expect(group?.target).toBe("#2");
      expect(group?.evidence.tags).toBe(`${prefix}1.0.0-rc.1 ${prefix}1.0.0`);
    }
  });

  it("leaves a kept decision with no release facts to the ordinary groups", () => {
    const empty = JSON.stringify({ target: "#45", evidence: {} });
    const actions = releaseActions([
      release("v1.0.0", "#1", empty),
      release("v1.1.0", "#2", empty),
    ]);
    expect(actions.map((a) => a.evidence.tags)).toEqual(["v1.0.0 v1.1.0"]);
  });
});
