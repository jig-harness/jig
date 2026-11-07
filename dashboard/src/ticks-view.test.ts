import { describe, expect, it } from "bun:test";
import type {
  LineSnapshot,
  LineTick,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import { slowestPhase, tickRows } from "./ticks-view.ts";
import type { Clock } from "./view.ts";

const NOW = Date.UTC(2026, 10, 3, 16, 47, 30);
const CLOCK: Clock = { nowMs: NOW, timeZone: "UTC" };

function lineOf(id: Parameters<typeof fixture>[0]): LineSnapshot {
  const { line } = fixture(id);
  if (line === null) throw new Error(`the ${id} scenario has no line`);
  return line;
}

const TICK: LineTick = {
  runId: "run-1",
  startedAt: "2026-11-03T16:40:00.000Z",
  tookMs: 42_000,
  exitStatus: 0,
  sweep: true,
  phasesMs: { start: 1_000, repos: 39_000, close: 2_000 },
  repos: [
    {
      repo: "example-org/web",
      ms: 30_520,
      phasesMs: { open: 500, forge: 30_000, plan: 20 },
      defect: null,
    },
    {
      repo: "example-org/api",
      ms: 8_000,
      phasesMs: { forge: 8_000 },
      defect: null,
    },
  ],
  budget: { remaining: 4_200, limit: 5_000 },
  busy: [],
  lowBudget: null,
  defects: 0,
};

function withTicks(ticks: LineTick[]): LineSnapshot {
  return { ...lineOf("quiet"), ticks };
}

describe("the tick strip", () => {
  it("lists the newest tick first, with its length, its slowest phase and the budget it read", () => {
    const older = { ...TICK, runId: "run-0", tookMs: 84_000 };
    const [row, second] = tickRows(withTicks([older, TICK]), CLOCK);
    expect(row).toMatchObject({
      key: "run-1",
      at: "16:40",
      took: "42 s",
      scale: 0.5,
      slowest: "forge in example-org/web, 30 s",
      scope: "2 repositories, all",
      budget: { remaining: "4,200", limit: "5,000" },
      marks: [],
    });
    expect(second?.scale).toBe(1);
    expect(row?.phases.map((p) => p.phase)).toEqual([
      "start",
      "repos",
      "close",
    ]);
    expect(row?.repos[0]?.phases.replace(/\u00a0/g, " ")).toBe(
      "forge 30 s · open 500 ms · plan 20 ms",
    );
  });

  it("names the tick's own phase as the slowest when it outlasts every repository's, never the phase that adds them up", () => {
    expect(
      slowestPhase({
        phasesMs: { start: 1_000, observe: 50_000, wait: 31_000, act: 40_000 },
        repos: [
          { repo: "a", ms: 30_000, phasesMs: { forge: 30_000 }, defect: null },
        ],
      }),
    ).toEqual({ phase: "wait", repo: null, ms: 31_000 });
    expect(slowestPhase({ phasesMs: {}, repos: [] })).toBeNull();
  });

  it("marks a tick that skipped its optional reads for a low budget, found a repository busy, or recorded a defect", () => {
    const [row] = tickRows(
      withTicks([
        {
          ...TICK,
          sweep: false,
          exitStatus: 1,
          busy: ["/srv/work/docs"],
          lowBudget: ["thread samples"],
          defects: 2,
        },
      ]),
      CLOCK,
    );
    expect(row?.marks.map((m) => [m.word, m.tone])).toEqual([
      ["2 defects", "badly"],
      ["low budget", "waiting"],
      ["1 busy", "held"],
    ]);
    expect(row?.marks[1]?.meaning).toContain("thread samples");
    expect(row?.scope).toBe("2 of 5 repositories");
    expect(row?.busy).toEqual(["/srv/work/docs"]);
  });

  it("marks a failed exit without a defect, and leaves out what the receipt did not record", () => {
    const [row] = tickRows(
      withTicks([
        {
          ...TICK,
          exitStatus: 1,
          phasesMs: {},
          repos: [],
          budget: null,
        },
      ]),
      CLOCK,
    );
    expect(row?.marks.map((m) => m.word)).toEqual(["exit 1"]);
    expect(row?.phases).toEqual([]);
    expect(row?.slowest).toBeNull();
    expect(row?.budget).toBeNull();
  });

  it("has no rows for a line written before ticks were kept", () => {
    const { ticks: _ticks, ...older } = lineOf("quiet");
    expect(tickRows(older, CLOCK)).toEqual([]);
    expect(tickRows(null, CLOCK)).toEqual([]);
  });

  it("shows the fixture's low-budget tick marked on the loud morning", () => {
    const rows = tickRows(lineOf("loud"), CLOCK);
    expect(rows.length).toBeGreaterThan(8);
    expect(rows.some((r) => r.marks.some((m) => m.word === "low budget"))).toBe(
      true,
    );
  });
});
