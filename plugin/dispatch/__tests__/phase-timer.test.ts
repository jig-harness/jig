/** dispatch: the phase timer adds the elapsed time of each phase, returned or thrown. */
import { describe, expect, it } from "bun:test";
import { PhaseTimer } from "../lib/phase-timer.ts";

describe("PhaseTimer", () => {
  it("measures a delayed phase and adds a phase run twice", async () => {
    const timer = new PhaseTimer<"a">();
    await timer.time("a", () => Bun.sleep(30));
    const first = timer.ms.a ?? 0;
    expect(first).toBeGreaterThanOrEqual(20);
    await timer.time("a", () => Bun.sleep(30));
    expect(timer.ms.a ?? 0).toBeGreaterThanOrEqual(first + 20);
    expect(timer.current).toBeNull();
  });

  it("times a phase that throws and keeps it as the current one", async () => {
    const timer = new PhaseTimer<"b">();
    await expect(
      timer.time("b", async () => {
        await Bun.sleep(30);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(timer.ms.b ?? 0).toBeGreaterThanOrEqual(20);
    expect(timer.current).toBe("b");
  });
});
