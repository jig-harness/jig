/**
 * The overlap cost, tier and bound (design/overlap-aware-admission.md):
 * canonical shared units, the chance of a round, the cost summed over the
 * work in flight, the bound counted on files alone, patience and promotion,
 * and the walk that weighs each pickup after those planned ahead of it.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_OVERLAP,
  type OverlapSettings,
} from "../lib/overlap-config.ts";
import {
  type Candidate,
  evaluate,
  type Footprint,
  type InFlight,
  type OverlapModel,
  roundChance,
  sharedUnits,
  canonical,
  UNKNOWN_FOOTPRINT,
  type Wait,
  walkOverlap,
} from "../lib/overlap.ts";
import { overlapModel } from "../lib/overlap-plan.ts";
import { parseMs } from "../../shared/time.ts";
import type { ChangeAreaCatalog } from "../../skills/drive-pr/scripts/lib/change-areas-catalog.ts";

const HOUR = 3_600_000;
const NOW = parseMs("2026-11-18T12:00:00.000Z");

const files = (...paths: string[]): Footprint => ({
  known: true,
  files: paths.filter((p) => !p.endsWith("/")),
  dirs: paths.filter((p) => p.endsWith("/")),
  areas: [],
});
const areas = (...keys: string[]): Footprint => ({
  known: true,
  files: [],
  dirs: [],
  areas: keys,
});
const with_ = (f: Footprint, more: Partial<Footprint>): Footprint => ({
  ...f,
  ...more,
});

const catalog = (entries: Record<string, string[]>, generated: string[] = []) =>
  new Map(
    Object.entries(entries).map(([key, globs], i) => [
      key,
      {
        globs,
        labels: [],
        trackerLabels: [],
        flags: [],
        serialize: false,
        fields:
          i === 0 && generated.length > 0
            ? { generated: [{ outputs: generated }] }
            : {},
      },
    ]),
  ) as ChangeAreaCatalog;

function model(
  settings: Partial<OverlapSettings> = {},
  rates: Record<string, number> = {},
  areaGlobs: Record<string, string[]> = { dispatch: ["src/dispatch/**"] },
  generated: string[] = [],
): OverlapModel {
  const s = { ...DEFAULT_OVERLAP, ...settings };
  return overlapModel(
    s,
    (p) => rates[p] ?? s.fileRate,
    catalog(areaGlobs, generated),
  );
}

const pr = (n: number, footprint: Footprint, quiet = false): InFlight => ({
  kind: "pull request",
  ref: `#${n}`,
  url: `https://example.test/pull/${n}`,
  state: quiet ? "open, quiet" : "open",
  footprint,
  quiet,
});
const pickup = (key: string, footprint: Footprint): InFlight => ({
  kind: "pickup",
  ref: key,
  url: null,
  state: "claimed",
  footprint,
  quiet: false,
});
const candidate = (
  item: string,
  footprint: Footprint,
  priority: Candidate["priority"] = "medium",
): Candidate => ({ item, url: null, priority, footprint });

const cost = (c: Footprint, w: InFlight[], m = model()) =>
  evaluate(c, w, m).cost;

describe("shared units", () => {
  it("counts a file in both footprints at its rate", () => {
    const m = model({}, { "src/a.ts": 0.3 });
    expect(
      sharedUnits(files("src/a.ts"), files("src/a.ts", "src/b.ts"), m),
    ).toEqual([{ path: "src/a.ts", rate: 0.3, coarse: false }]);
  });

  it("counts a directory or an area holding the other's file as one coarse unit at area_rate", () => {
    const m = model();
    expect(
      sharedUnits(files("src/dispatch/"), files("src/dispatch/x.ts"), m),
    ).toEqual([{ path: "src/dispatch/", rate: 0.2, coarse: true }]);
    expect(
      sharedUnits(areas("dispatch"), files("src/dispatch/x.ts"), m),
    ).toEqual([{ path: "area dispatch", rate: 0.2, coarse: true }]);
    expect(
      sharedUnits(files("src/dispatch/x.ts"), areas("dispatch"), m),
    ).toHaveLength(1);
    expect(sharedUnits(areas("dispatch"), areas("dispatch"), m)).toHaveLength(
      1,
    );
    expect(sharedUnits(files("src/"), areas("dispatch"), m)).toHaveLength(1);
  });

  it("keeps every coarse match that holds no file match together as one unit", () => {
    const m = model(
      {},
      {},
      { dispatch: ["src/dispatch/**"], ui: ["src/ui/**"] },
    );
    const units = sharedUnits(
      with_(files("src/dispatch/", "src/ui/"), { areas: ["ui"] }),
      files("src/dispatch/a.ts", "src/ui/b.ts"),
      m,
    );
    expect(units).toEqual([{ path: "area ui", rate: 0.2, coarse: true }]);
  });

  it("drops a coarse match whose directory or area holds a file match", () => {
    const m = model({}, { "src/dispatch/a.ts": 0.4 });
    expect(
      sharedUnits(
        files("src/dispatch/", "src/dispatch/a.ts"),
        files("src/dispatch/a.ts", "src/dispatch/b.ts"),
        m,
      ),
    ).toEqual([{ path: "src/dispatch/a.ts", rate: 0.4, coarse: false }]);
  });

  it("finds nothing shared between footprints in different places", () => {
    expect(sharedUnits(files("src/a.ts"), files("src/b.ts"), model())).toEqual(
      [],
    );
    expect(
      sharedUnits(files("src/dispatch/"), files("docs/x.md"), model()),
    ).toEqual([]);
    expect(
      sharedUnits(
        areas("dispatch"),
        areas("ui"),
        model({}, {}, { dispatch: ["src/dispatch/**"], ui: ["src/ui/**"] }),
      ),
    ).toEqual([]);
  });

  it("leaves out a generated or ignored file", () => {
    const m = model(
      { ignore: ["CHANGELOG.md"] },
      {},
      { dispatch: ["src/dispatch/**"] },
      ["src/gen/**"],
    );
    expect(
      canonical(files("CHANGELOG.md", "src/gen/x.ts", "src/a.ts"), m).files,
    ).toEqual(["src/a.ts"]);
    expect(
      cost(
        files("CHANGELOG.md", "src/gen/x.ts"),
        [pr(1, files("CHANGELOG.md", "src/gen/x.ts"))],
        m,
      ),
    ).toBe(0);
  });
});

describe("the chance of a round and the cost", () => {
  it("is 1 − ∏(1 − rate) over the shared units", () => {
    expect(roundChance([])).toBe(0);
    expect(
      roundChance([
        { path: "a", rate: 0.5, coarse: false },
        { path: "b", rate: 0.5, coarse: false },
      ]),
    ).toBeCloseTo(0.75);
  });

  it("sums the chance over the work in flight", () => {
    const m = model({}, { "src/a.ts": 0.5, "src/b.ts": 0.2 });
    const c = files("src/a.ts", "src/b.ts");
    const work = [
      pr(1, files("src/a.ts")),
      pickup("ENG-2", files("src/a.ts", "src/b.ts")),
      pr(3, files("docs/x")),
    ];
    expect(cost(c, work, m)).toBeCloseTo(0.5 + (1 - 0.5 * 0.8));
  });

  it("never changes with redundant paths or areas", () => {
    const m = model({}, { "src/dispatch/a.ts": 0.4 });
    const work = [
      pr(1, files("src/dispatch/a.ts", "src/dispatch/b.ts", "src/ui/c.ts")),
    ];
    const base = cost(files("src/dispatch/a.ts"), work, m);
    expect(cost(files("src/dispatch/a.ts", "src/dispatch/a.ts"), work, m)).toBe(
      base,
    );
    expect(cost(files("src/dispatch/a.ts", "src/dispatch/"), work, m)).toBe(
      base,
    );
    expect(
      cost(with_(files("src/dispatch/a.ts"), { areas: ["dispatch"] }), work, m),
    ).toBe(base);
    const coarse = cost(files("src/dispatch/"), work, m);
    expect(
      cost(
        with_(files("src/dispatch/", "src/dispatch/sub/"), {
          areas: ["dispatch"],
        }),
        work,
        m,
      ),
    ).toBe(coarse);
  });

  it("weighs an unknown candidate footprint at unknown_cost once, whatever is in flight", () => {
    const m = model({ unknownCost: 0.7 });
    expect(evaluate(UNKNOWN_FOOTPRINT, [], m)).toMatchObject({
      unknown: true,
      cost: 0.7,
    });
    expect(
      evaluate(UNKNOWN_FOOTPRINT, [pr(1, files("a")), pr(2, files("b"))], m)
        .cost,
    ).toBe(0.7);
  });

  it("counts no chance with work in flight whose footprint is unknown", () => {
    expect(cost(files("src/a.ts"), [pr(1, UNKNOWN_FOOTPRINT)])).toBe(0);
  });
});

describe("the overlap bound", () => {
  const busy = (n: number, quiet = false) =>
    Array.from({ length: n }, (_, i) => pr(i + 1, files("src/hot.ts"), quiet));

  it("holds a candidate when the work in flight changing one of its files reaches max_per_file", () => {
    const m = model({ maxPerFile: 2 });
    expect(evaluate(files("src/hot.ts"), busy(1), m).bound).toBeNull();
    expect(evaluate(files("src/hot.ts"), busy(2), m).bound).toMatchObject({
      path: "src/hot.ts",
    });
  });

  it("counts file matches only, never a directory or an area", () => {
    const m = model({ maxPerFile: 1 });
    expect(
      evaluate(files("src/hot.ts"), [pr(1, files("src/"))], m).bound,
    ).toBeNull();
    expect(evaluate(files("src/"), busy(3), m).bound).toBeNull();
  });

  it("leaves out a quiet pull request, which still counts toward the cost", () => {
    const m = model({ maxPerFile: 2 });
    const e = evaluate(files("src/hot.ts"), busy(3, true), m);
    expect(e.bound).toBeNull();
    expect(e.cost).toBeGreaterThan(0);
  });

  it("leaves out an ignored file, and is off at 0", () => {
    expect(
      evaluate(
        files("src/hot.ts"),
        busy(9),
        model({ maxPerFile: 2, ignore: ["src/hot.ts"] }),
      ).bound,
    ).toBeNull();
    expect(
      evaluate(files("src/hot.ts"), busy(9), model({ maxPerFile: 0 })).bound,
    ).toBeNull();
  });
});

describe("tiers, patience and promotion", () => {
  const work = [pr(1, files("src/a.ts"))];
  const wait = (sinceMs: number, more: Partial<Wait> = {}): Wait => ({
    sinceMs,
    tier3SinceMs: null,
    promotedMs: null,
    ...more,
  });

  it("puts no overlap in tier 1 and overlap in tier 2, with a wait from this tick", () => {
    const [free] = walkOverlap(
      [candidate("A", files("src/z.ts"))],
      work,
      new Map(),
      model(),
      NOW,
    );
    expect(free).toMatchObject({ tier: 1, wait: null });
    const [busy] = walkOverlap(
      [candidate("B", files("src/a.ts"))],
      work,
      new Map(),
      model(),
      NOW,
    );
    expect(busy).toMatchObject({ tier: 2, raw: 2, wait: { sinceMs: NOW } });
    // Medium priority: 2 h for each expected round (0.5 here).
    expect(busy?.patienceEndsMs).toBe(NOW + HOUR);
  });

  it("returns a tier-2 pickup to tier 1 once its priority's patience times its cost is spent", () => {
    const waits = new Map([["B", wait(NOW - HOUR)]]);
    const [spent] = walkOverlap(
      [candidate("B", files("src/a.ts"))],
      work,
      waits,
      model(),
      NOW,
    );
    expect(spent).toMatchObject({
      tier: 1,
      patienceSpent: true,
      wait: { sinceMs: NOW - HOUR },
    });
    const [urgent] = walkOverlap(
      [candidate("U", files("src/a.ts"), "urgent")],
      work,
      new Map(),
      model(),
      NOW,
    );
    expect(urgent).toMatchObject({ tier: 1, patienceSpent: true });
    const [low] = walkOverlap(
      [candidate("B", files("src/a.ts"), "low")],
      work,
      waits,
      model(),
      NOW,
    );
    expect(low?.tier).toBe(2);
  });

  it("keeps a tier-3 pickup there past its patience, and promotes it once it waited past bound_patience", () => {
    const m = model({ maxPerFile: 1 });
    const long = new Map([["C", wait(NOW - 48 * HOUR)]]);
    const [first] = walkOverlap(
      [candidate("C", files("src/a.ts"), "urgent")],
      work,
      long,
      m,
      NOW,
    );
    expect(first).toMatchObject({
      tier: 3,
      promoted: false,
      wait: { tier3SinceMs: NOW },
    });
    const over = new Map([
      ["C", wait(NOW - 48 * HOUR, { tier3SinceMs: NOW - 25 * HOUR })],
    ]);
    const [promoted] = walkOverlap(
      [candidate("C", files("src/a.ts"))],
      work,
      over,
      m,
      NOW,
    );
    expect(promoted).toMatchObject({
      tier: 1,
      promoted: true,
      wait: { promotedMs: NOW },
    });
  });

  it("keeps a promotion until the wait ends, whatever the overlap", () => {
    const kept = new Map([
      [
        "C",
        wait(NOW - 30 * HOUR, {
          tier3SinceMs: NOW - 30 * HOUR,
          promotedMs: NOW - HOUR,
        }),
      ],
    ]);
    const [p] = walkOverlap(
      [candidate("C", files("src/a.ts"))],
      work,
      kept,
      model(),
      NOW,
    );
    expect(p).toMatchObject({ tier: 1, promoted: true });
  });
});

describe("the walk", () => {
  it("weighs each pickup after the ones planned ahead of it, so two overlapping pickups are not both free", () => {
    const placed = walkOverlap(
      [candidate("A", files("src/a.ts")), candidate("B", files("src/a.ts"))],
      [],
      new Map(),
      model(),
      NOW,
    );
    expect(placed.map((p) => [p.candidate.item, p.tier])).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
    expect(placed[1]?.evaluation.shares[0]?.work).toMatchObject({
      kind: "pickup",
      ref: "A",
      state: "planned ahead of it",
    });
  });

  it("takes tier by tier, rank order inside each, and the promoted first, longest waiter first", () => {
    const work = [pr(1, files("src/hot.ts"))];
    const m = model({ maxPerFile: 1 });
    const waits = new Map<string, Wait>([
      [
        "P2",
        {
          sinceMs: NOW - 40 * HOUR,
          tier3SinceMs: NOW - 40 * HOUR,
          promotedMs: NOW - HOUR,
        },
      ],
      [
        "P1",
        {
          sinceMs: NOW - 50 * HOUR,
          tier3SinceMs: NOW - 50 * HOUR,
          promotedMs: NOW - HOUR,
        },
      ],
    ]);
    const placed = walkOverlap(
      [
        candidate("T2", files("src/hot.ts", "src/x.ts"), "low"),
        candidate("T1", files("src/free.ts")),
        candidate("P2", files("src/p2.ts")),
        candidate("P1", files("src/p1.ts")),
      ],
      work,
      waits,
      m,
      NOW,
    );
    expect(placed.map((p) => p.candidate.item)).toEqual([
      "P1",
      "P2",
      "T1",
      "T2",
    ]);
    expect(placed.map((p) => p.rank)).toEqual([3, 2, 1, 0]);
  });
});
