/**
 * The overlap walk's records in the state database: a pickup's wait is kept
 * from the first tick that put it in tier 2 or 3 until it starts or is no
 * longer wanted, and a file that kept work over the bound is counted once a
 * tick, per day.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countHotspots, readWaits, settleWaits } from "../lib/overlap-waits.ts";
import { closeStateDb } from "../lib/state.ts";

const REPO = "example-org/example-repo";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true });
  }
});

function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jig-overlap-waits-")));
  roots.push(dir);
  return dir;
}

const wait = (
  sinceMs: number,
  tier3SinceMs: number | null = null,
  promotedMs: number | null = null,
) => ({
  sinceMs,
  tier3SinceMs,
  promotedMs,
});

describe("overlap_waits", () => {
  it("keeps a wait from its first tick, updates its tier-3 and promotion times, and leaves another repository's alone", () => {
    const r = root();
    settleWaits(
      REPO,
      new Map([
        ["#12", wait(1000)],
        ["#13", null],
      ]),
      new Set(["#12", "#13"]),
      r,
    );
    settleWaits(
      "example-org/other",
      new Map([["#12", wait(5)]]),
      new Set(["#12"]),
      r,
    );
    expect([...readWaits(REPO, r)]).toEqual([["#12", wait(1000)]]);
    settleWaits(
      REPO,
      new Map([["#12", wait(1000, 2000, 3000)]]),
      new Set(["#12"]),
      r,
    );
    expect(readWaits(REPO, r).get("#12")).toEqual(wait(1000, 2000, 3000));
    expect(readWaits("example-org/other", r).get("#12")).toEqual(wait(5));
  });

  it("removes a wait once its item started or is no longer wanted, and keeps every one while that is not known", () => {
    const r = root();
    settleWaits(
      REPO,
      new Map([
        ["#12", wait(1000)],
        ["#13", wait(1000)],
      ]),
      new Set(["#12", "#13"]),
      r,
    );
    // The tracker's read was not whole: nothing is removed.
    settleWaits(REPO, new Map(), null, r);
    expect([...readWaits(REPO, r).keys()].sort()).toEqual(["#12", "#13"]);
    // #13 started (or left the dispatch states); #12 is wanted but not planned this tick.
    settleWaits(REPO, new Map(), new Set(["#12"]), r);
    expect([...readWaits(REPO, r).keys()]).toEqual(["#12"]);
    // Wanted again later, it waits from a new first tick.
    settleWaits(
      REPO,
      new Map([["#13", wait(9000)]]),
      new Set(["#12", "#13"]),
      r,
    );
    expect(readWaits(REPO, r).get("#13")).toEqual(wait(9000));
  });
});

describe("overlap_hotspots", () => {
  it("counts each file once a tick, per repository and day, and drops days before the previous one", () => {
    const r = root();
    expect([
      ...countHotspots(
        REPO,
        "2026-11-18",
        "2026-11-17",
        ["a.ts", "a.ts", "b.ts"],
        r,
      ),
    ]).toEqual([
      ["a.ts", 1],
      ["b.ts", 1],
    ]);
    countHotspots(REPO, "2026-11-18", "2026-11-17", ["a.ts"], r);
    expect(
      countHotspots(REPO, "2026-11-18", "2026-11-17", ["a.ts"], r).get("a.ts"),
    ).toBe(3);
    expect(
      countHotspots(
        "example-org/other",
        "2026-11-18",
        "2026-11-17",
        ["a.ts"],
        r,
      ).get("a.ts"),
    ).toBe(1);
    // A new day starts again; two days on, the old rows are gone.
    expect(
      countHotspots(REPO, "2026-11-19", "2026-11-18", ["a.ts"], r).get("a.ts"),
    ).toBe(1);
    countHotspots(REPO, "2026-11-20", "2026-11-19", ["c.ts"], r);
    expect(
      countHotspots(REPO, "2026-11-18", "2026-11-19", ["a.ts"], r).get("a.ts"),
    ).toBe(1);
  });
});
