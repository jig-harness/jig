/** dispatch: each row of the ledger-to-class table, first match wins. */
import { describe, expect, it } from "bun:test";
import { classifyLedger } from "../lib/sources/ledgers.ts";
import { stoppedLedger } from "./fixtures.ts";

const NOW = Date.parse("2026-10-31T00:00:00.000Z");
const WINDOW = 240 * 60_000;

function running(minutesAgo: number) {
  const ledger = stoppedLedger(7, undefined);
  return {
    ...ledger,
    driver: {
      ...ledger.driver,
      state: "running" as const,
      heartbeat: new Date(NOW - minutesAgo * 60_000).toISOString(),
    },
  };
}

const classOf = (
  exit: number | undefined,
  park?: Parameters<typeof classifyLedger>[3],
) => classifyLedger(stoppedLedger(7, exit), NOW, WINDOW, park).class;

describe("classifyLedger", () => {
  it("reads a running driver by its heartbeat against the lease window", () => {
    expect(classifyLedger(running(10), NOW, WINDOW).class).toBe("driven");
    expect(classifyLedger(running(241), NOW, WINDOW).class).toBe("silent");
  });

  it("reads each stopped exit as the table says", () => {
    expect([0, 5, 20].map((e) => classOf(e))).toEqual(["done", "done", "done"]);
    expect([18, 19].map((e) => classOf(e))).toEqual([
      "stopped-by-person",
      "stopped-by-person",
    ]);
    expect(classOf(undefined)).toBe("stopped-unknown");
    expect(classOf(16)).toBe("re-armable");
    expect(classOf(4)).toBe("re-armable");
    expect([11, 13].map((e) => classOf(e))).toEqual(["refused", "refused"]);
    expect([1, 2, 6, 7, 9, 12, 14, 15, 99].map((e) => classOf(e))).toEqual(
      Array(9).fill("needs-person"),
    );
  });

  it("re-arms a park only once every parked item is answered", () => {
    expect(classOf(8, { answered: 2, waiting: [] })).toBe("re-armable");
    expect(classOf(8, { answered: 1, waiting: ["thread PRRT_a"] })).toBe(
      "parked",
    );
    expect(classOf(8, { unreadable: "thread PRRT_a" })).toBe("unplaced");
    expect(classOf(8)).toBe("unplaced");
  });

  it("cannot place a running driver whose heartbeat does not read", () => {
    const ledger = running(1);
    ledger.driver.heartbeat = "yesterday";
    expect(classifyLedger(ledger, NOW, WINDOW).class).toBe("unplaced");
  });
});
