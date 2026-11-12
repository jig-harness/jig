/** `drive-state.ts rule` validates a ruling's context time before it normalizes it. */
import { describe, expect, it } from "bun:test";
import { recordRuling } from "../scripts/lib/state/rulings.ts";

const store = {
  update: async () => undefined,
} as unknown as Parameters<typeof recordRuling>[0];

const run = async (contextAt: string): Promise<number | string> => {
  const raw = JSON.stringify({ key: "PRRT_x", verdict: "fix-now", contextAt });
  try {
    return await recordRuling(store, raw);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe("recordRuling's contextAt", () => {
  it("refuses a time that does not parse, with the usage exit rather than a RangeError", async () => {
    for (const bad of ["not a time", ""]) {
      const out = await run(bad);
      expect(out).toBe("exit 2");
    }
  });

  it("refuses a parseable time that is not a real calendar time or has no zone", async () => {
    for (const bad of [
      "2026-02-30T12:00:00Z",
      "2026-01-01T12:00:00",
      "2026-01-01",
      "2026-01-01T24:00:00Z",
      "2026-01-01T12:00:00+25:00",
    ])
      expect(await run(bad)).toBe("exit 2");
  });

  it("records a past time with an offset", async () => {
    expect(await run("2026-01-01T12:00:00.5+02:00")).toBe(0);
  });

  it("refuses a time in the future", async () => {
    expect(await run("2099-01-01T00:00:00Z")).toBe("exit 2");
  });

  it("records a past time", async () => {
    expect(await run("2026-01-01T00:00:00Z")).toBe(0);
  });
});
