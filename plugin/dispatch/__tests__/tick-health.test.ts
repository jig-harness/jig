/**
 * Each tick's entry on the dashboard's tick strip, from its receipt: the
 * phases, the repositories, the budget and the counts, whether the receipt
 * comes from a tick that observed in turn or one that observed every
 * repository at once and recorded busy repositories and a low budget.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { readLine, writeLine } from "../lib/line-store.ts";
import { closeStateDb } from "../lib/state.ts";
import {
  type HealthReceipt,
  RECENT_TICK_HEALTH,
  tickHealthOf,
  withTick,
} from "../lib/tick-health.ts";

const STARTED = "2026-11-07T10:00:00.000Z";

function receipt(over: Partial<HealthReceipt> = {}): HealthReceipt {
  return {
    runId: "run-1",
    startedAt: STARTED,
    finishedAt: "2026-11-07T10:00:42.000Z",
    exitStatus: 0,
    phasesMs: { start: 1_000, repos: 40_000 },
    repos: [
      {
        path: "/srv/web",
        slug: "acme/web",
        phasesMs: { open: 500, forge: 30_000, plan: 20 },
        shared: {
          medium: "forge",
          host: "h",
          owner: true,
          owners: [],
          ops: [],
          reads: 0,
          writes: 0,
          budget: { remaining: 4_200, limit: 5_000, resetAt: STARTED },
        },
      },
      {
        path: "/srv/api",
        slug: null,
        phasesMs: { open: 300 },
        defect: { code: "defect", phase: "forge", reason: "a bug" },
      },
    ],
    ...over,
  };
}

describe("a tick's entry on the strip", () => {
  it("carries the tick's phases with the close up to the line's write, each repository's phases, and the budget the shared records read", () => {
    const tick = tickHealthOf(receipt(), true);
    expect(tick).toEqual({
      runId: "run-1",
      startedAt: STARTED,
      tookMs: 42_000,
      exitStatus: 0,
      sweep: true,
      phasesMs: { start: 1_000, repos: 40_000, close: 1_000 },
      repos: [
        {
          repo: "acme/web",
          ms: 30_520,
          phasesMs: { open: 500, forge: 30_000, plan: 20 },
          defect: null,
        },
        {
          repo: "/srv/api",
          ms: 300,
          phasesMs: { open: 300 },
          defect: "forge",
        },
      ],
      budget: { remaining: 4_200, limit: 5_000 },
      busy: [],
      lowBudget: null,
      defects: 1,
    });
  });

  it("counts busy repositories, the low budget's skipped reads and the tick's own defect, and takes the budget from the gate", () => {
    const tick = tickHealthOf(
      receipt({
        phasesMs: { start: 900, observe: 8_000, wait: 0, act: 2_000 },
        busy: [{ path: "/srv/docs" }],
        lowBudget: {
          remaining: 120,
          limit: 5_000,
          skipped: ["thread samples", "contention"],
        },
        defect: { code: "defect", phase: "close", reason: "a bug" },
      }),
      false,
    );
    expect(tick.sweep).toBe(false);
    expect(tick.busy).toEqual(["/srv/docs"]);
    expect(tick.lowBudget).toEqual(["thread samples", "contention"]);
    expect(tick.budget).toEqual({ remaining: 120, limit: 5_000 });
    expect(tick.defects).toBe(2);
    expect(tick.phasesMs.close).toBe(42_000 - 10_900);
  });

  it("has no phases for a receipt that timed none, and no budget where none was read", () => {
    const tick = tickHealthOf(
      {
        runId: "old",
        startedAt: STARTED,
        finishedAt: STARTED,
        exitStatus: 0,
        repos: [{ path: "/srv/web", slug: "acme/web" }],
      },
      true,
    );
    expect(tick.phasesMs).toEqual({});
    expect(tick.repos).toEqual([
      { repo: "acme/web", ms: 0, phasesMs: {}, defect: null },
    ]);
    expect(tick.budget).toBeNull();
  });

  it("keeps the newest ticks, the oldest first, and one entry per run", () => {
    let ticks = withTick(undefined, tickHealthOf(receipt(), true));
    for (let i = 2; i <= RECENT_TICK_HEALTH + 5; i++)
      ticks = withTick(
        ticks,
        tickHealthOf(receipt({ runId: `run-${i}` }), true),
      );
    ticks = withTick(ticks, tickHealthOf(receipt({ runId: "run-53" }), true));
    expect(ticks).toHaveLength(RECENT_TICK_HEALTH);
    expect(ticks.at(-1)?.runId).toBe("run-53");
    expect(ticks.at(0)?.runId).toBe("run-6");
    expect(ticks.filter((t) => t.runId === "run-53")).toHaveLength(1);
  });
});

describe("the stored line's recent ticks", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root === null) return;
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function stored(ticks: unknown): ReturnType<typeof readLine> {
    root = mkdtempSync(join(tmpdir(), "tick-health-"));
    const line = {
      version: 1,
      runId: "run-1",
      startedAt: STARTED,
      finishedAt: "2026-11-07T10:00:42.000Z",
      exitStatus: 0,
      apply: true,
      applyWithheld: null,
      intervalMs: 300_000,
      longestTickMs: 42_000,
      plugin: null,
      accounts: [],
      lastAccount: null,
      sessions: [],
      needs: [],
      queue: [],
      repos: [],
      ticks,
    } as unknown as LineSnapshot;
    writeLine(line, "{}", root);
    return readLine(root);
  }

  it("read back as written", () => {
    const ticks = [tickHealthOf(receipt(), true)];
    const read = stored(ticks);
    expect(read.ok && read.value?.ticks).toEqual(ticks);
  });

  it("refuse the line when an entry is not in the strip's form", () => {
    const read = stored([{ runId: "run-1", tookMs: "slow" }]);
    expect(read.ok).toBe(false);
  });
});
