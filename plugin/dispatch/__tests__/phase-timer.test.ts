/** dispatch: the phase timer adds the elapsed time of each phase, returned or thrown. */
import { describe, expect, it } from "bun:test";
import { PhaseTimer, settled } from "../lib/phase-timer.ts";

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

  it("times overlapping phases each on its own, and names the one that threw, not the one that ended last", async () => {
    const timer = new PhaseTimer<"tracker" | "forge">();
    await expect(
      settled(
        timer.time("tracker", async () => {
          await Bun.sleep(10);
          throw new Error("tracker");
        }),
        timer.time("forge", () => Bun.sleep(40)),
      ),
    ).rejects.toThrow("tracker");
    expect(timer.current).toBe("tracker");
    expect(timer.ms.forge ?? 0).toBeGreaterThanOrEqual(30);
  });

  it("throws the error of the phase that threw first when both fail, whatever their order as arguments", async () => {
    const timer = new PhaseTimer<"tracker" | "forge">();
    await expect(
      settled(
        timer.time("tracker", async () => {
          await Bun.sleep(40);
          throw new Error("tracker");
        }),
        timer.time("forge", async () => {
          await Bun.sleep(5);
          throw new Error("forge");
        }),
      ),
    ).rejects.toThrow("forge");
    expect(timer.current).toBe("forge");
  });
});
