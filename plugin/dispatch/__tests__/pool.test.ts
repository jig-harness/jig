/** dispatch: the observe phase's pool keeps at most its size in flight, and takes waiting reads in the order they asked. */
import { describe, expect, it } from "bun:test";
import { pool } from "../lib/pool.ts";

describe("pool", () => {
  it("runs at most its size at once, and every read to the end", async () => {
    const reads = pool(3);
    let active = 0;
    let most = 0;
    const started: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reads.run(async () => {
          started.push(i);
          active += 1;
          most = Math.max(most, active);
          await Bun.sleep(5 + (i % 4) * 3);
          active -= 1;
          return i * 2;
        }),
      ),
    );
    expect(most).toBe(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i * 2));
    expect(started).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("frees a place when a read throws", async () => {
    const reads = pool(1);
    await expect(
      reads.run(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(await reads.run(async () => "next")).toBe("next");
  });

  it("falls back to the default size for a size that is no bound", async () => {
    for (const size of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const reads = pool(size);
      let active = 0;
      let most = 0;
      await Promise.all(
        Array.from({ length: 20 }, () =>
          reads.run(async () => {
            active += 1;
            most = Math.max(most, active);
            await Bun.sleep(3);
            active -= 1;
          }),
        ),
      );
      expect(most).toBe(6);
    }
  });
});
