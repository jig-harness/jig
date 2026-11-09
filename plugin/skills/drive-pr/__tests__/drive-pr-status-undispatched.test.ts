import { describe, expect, it } from "bun:test";
import {
  HEAD,
  hold,
  probeIn,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { editState } from "./state-rows.ts";

useDrivePrSuite();

describe("drive-status held summary dispatch", () => {
  it("reports unaddressed holds without a push stamp separately, with recovery", async () => {
    const { dir, stateDir } = writeFixture({ backlog: true });
    const keys = ["b9a7a18089043564", "c773d9fdb7974e6d"];
    for (const key of keys) await hold(stateDir, key, "finding");
    const r = await probeIn(dir, stateDir, HEAD);
    expect(
      (r.json.work as Record<string, unknown>).summaryHeldUndispatchedKeys,
    ).toEqual(keys);
    expect(r.json.reason).toContain(
      "held but not dispatched: re-hold to dispatch",
    );
    expect(r.state).toBe("ROUND_READY");
    editState(stateDir, "999", (s) => ({
      ...s,
      held: (s.held as Record<string, unknown>[]).map((h) => ({
        ...h,
        verifiedSha: HEAD,
      })),
    }));
    const stamped = await probeIn(dir, stateDir, HEAD);
    expect(
      (stamped.json.work as Record<string, unknown>)
        .summaryHeldUndispatchedKeys,
    ).toEqual([]);
    expect(stamped.json.reason).not.toContain("held but not dispatched");
  });

  it("does not report an answered finding even if a stale hold remains", async () => {
    const keys = ["b9a7a18089043564", "c773d9fdb7974e6d"];
    const { dir, stateDir } = writeFixture({ backlog: true, addressed: keys });
    for (const key of keys) await hold(stateDir, key, "finding");
    const r = await probeIn(dir, stateDir, HEAD);
    expect(
      (r.json.work as Record<string, unknown>).summaryHeldUndispatchedKeys,
    ).toEqual([]);
  });
});
