/**
 * The proposal: anchors resolved against the catalog and the tracker, the
 * ranking, the budget, the labelling-gap report and the table a person
 * reads. The tracker is the in-memory one in `helpers.ts`.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolIssue } from "../../do-item/scripts/lib/tracker/port.ts";
import {
  buildProposal,
  type Candidate,
  capCandidates,
  eligibilityReport,
  fillBudget,
  globMayMatchUnder,
  normalizeRepoPath,
  type Proposal,
  parsePoolIssues,
  rank,
  REVALIDATION_FIELD_KEYS,
  renderTable,
  revalidationLine,
  run,
  verdictSizes,
} from "../scripts/candidates.ts";
import { Refusal } from "../scripts/lib/errors.ts";
import { catalog, fakeTracker, issue, policy, relabel } from "./helpers.ts";

const P = policy();
const base = issue("ENG-0").labels;
const opts = (
  over: Partial<{ limit: number; budget: number; claimed: Set<string> }> = {},
) => ({
  limit: P.maxItems,
  budget: P.pointBudget,
  claimed: new Set<string>(),
  ...over,
});

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
/** A repository root with the directories `dirs` on disk, for path anchors. */
function root(...dirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "work-batch-root-"));
  scratch.push(dir);
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Refusal) return err.message;
    throw err;
  }
  throw new Error("expected a refusal");
}

const ids = (cs: { identifier: string }[]) => cs.map((c) => c.identifier);

describe("ranking", () => {
  it("ranks smaller sizes first by default", () => {
    const ranked = rank(
      [
        issue("ENG-1", { labels: relabel(base, ["small"], ["medium"]) }),
        issue("ENG-2"),
        issue("ENG-3", { labels: relabel(base, ["small"], ["xs"]) }),
      ],
      P,
      [],
    );
    expect(ids(ranked)).toEqual(["ENG-3", "ENG-2", "ENG-1"]);
    expect(ranked.map((c) => c.score)).toEqual([2, 1, 0]);
    expect(ranked.map((c) => c.points)).toEqual([1, 2, 6]);
  });

  it("adds the follow-up weight and one weight per shared area label", () => {
    const [c] = rank(
      [issue("ENG-1", { labels: [...base, "pr-followup", "domain:payments"] })],
      P,
      ["domain:payments"],
    );
    expect(c?.score).toBe(1 + 3 + 1);
    expect(c?.reasons).toEqual([
      "small (+1)",
      "review follow-up (+3)",
      "shares domain:payments (+1)",
    ]);
  });

  it("reads the weights the repository sets", () => {
    const tuned = policy({
      work_batch: {
        sizes: ["xs", "small", "medium", "large", "xl"],
        ranking: { sizes: { medium: 9 }, provenance: 0 },
      },
    });
    const ranked = rank(
      [
        issue("ENG-1", { labels: [...base, "pr-followup"] }),
        issue("ENG-2", { labels: relabel(base, ["small"], ["medium"]) }),
      ],
      tuned,
      [],
    );
    expect(ids(ranked)).toEqual(["ENG-2", "ENG-1"]);
  });

  it("breaks ties by priority (urgent first, none last), then age, then key", () => {
    const at = (iso: string) => ({ createdAt: iso });
    const ranked = rank(
      [
        issue("ENG-5", { priority: 0, ...at("2026-01-01T00:00:00Z") }),
        issue("ENG-4", { priority: 4, ...at("2026-01-01T00:00:00Z") }),
        issue("ENG-3", { priority: 2, ...at("2026-02-01T00:00:00Z") }),
        issue("ENG-2", { priority: 2, ...at("2026-01-01T00:00:00Z") }),
        issue("ENG-10", { priority: 1, ...at("2026-03-01T00:00:00Z") }),
        issue("ENG-1", { priority: 1, ...at("2026-03-01T00:00:00Z") }),
      ],
      P,
      [],
    );
    expect(ids(ranked)).toEqual([
      "ENG-1",
      "ENG-10",
      "ENG-2",
      "ENG-3",
      "ENG-4",
      "ENG-5",
    ]);
  });

  it("carries the assignee and state ids into each candidate", () => {
    const [c] = rank(
      [
        issue("ENG-1", {
          assignee: { id: "u-7", name: "Sam" },
          state: { id: "s-ip", name: "In Progress", type: "started" },
        }),
      ],
      P,
      [],
    );
    expect(c?.assignee).toEqual({ id: "u-7", name: "Sam" });
    expect(c?.state).toEqual({
      id: "s-ip",
      name: "In Progress",
      type: "started",
    });
  });

  it("gives the same order whatever the input order", () => {
    const issues = Array.from({ length: 8 }, (_, i) =>
      issue(`ENG-${i + 1}`, { createdAt: "2026-01-01T00:00:00Z" }),
    );
    const forward = ids(rank(issues, P, []));
    expect(ids(rank([...issues].reverse(), P, []))).toEqual(forward);
  });
});

describe("the budget", () => {
  const sized = (id: string, size: string) =>
    issue(id, { labels: relabel(base, ["small"], [size]) });

  it("skips an issue that does not fit and keeps filling with smaller ones", () => {
    const ranked = rank(
      [
        sized("ENG-1", "medium"),
        sized("ENG-2", "medium"),
        sized("ENG-3", "medium"),
        sized("ENG-4", "small"),
        sized("ENG-5", "small"),
      ],
      P,
      [],
    );
    const kept = capCandidates(ranked, { limit: 6, budget: 16 }, null);
    expect(ids(kept)).toEqual(["ENG-4", "ENG-5", "ENG-1", "ENG-2"]);
    expect(kept.reduce((s, c) => s + c.points, 0)).toBe(16);
  });

  it("never proposes more than two mediums at the default budget", () => {
    const ranked = rank(
      Array.from({ length: 5 }, (_, i) => sized(`ENG-${i + 1}`, "medium")),
      P,
      [],
    );
    expect(capCandidates(ranked, { limit: 6, budget: 16 }, null)).toHaveLength(
      2,
    );
  });

  it("lets the item limit bind first for xs and small issues", () => {
    const ranked = rank(
      Array.from({ length: 9 }, (_, i) => sized(`ENG-${i + 1}`, "small")),
      P,
      [],
    );
    const kept = capCandidates(ranked, { limit: 6, budget: 16 }, null);
    expect(kept).toHaveLength(6);
    expect(kept.reduce((s, c) => s + c.points, 0)).toBe(12);
  });

  it("counts equal items separately and charges a pinned one against both limits", () => {
    expect(fillBudget([1, 1, 1], (n) => n, { limit: 2, budget: 10 })).toEqual([
      1, 1,
    ]);
    expect(
      fillBudget([5, 1, 1], (n) => n, {
        limit: 2,
        budget: 6,
        pinned: (n) => n === 1,
      }),
    ).toEqual([1, 1]);
  });

  it("asks for a verdict on the most expensive batchable size only", () => {
    expect(verdictSizes(P)).toEqual(["medium"]);
    const flat = policy({
      work_batch: {
        sizes: ["xs", "small", "medium", "large", "xl"],
        size_points: { xs: 1, small: 1, medium: 1 },
      },
    });
    expect(verdictSizes(flat)).toEqual([]);
  });
});

describe("area and path anchors", () => {
  it("reads the pool by the area-naming label and a batchable size, and ranks the shared labels", async () => {
    const tracker = fakeTracker([
      issue("ENG-1"),
      issue("ENG-2", {
        labels: relabel(base, ["area:billing"], ["area:search"]),
      }),
    ]);
    const p = await run(tracker, catalog(), P, "billing", opts(), root());
    expect(p.anchor).toEqual({
      kind: "area",
      input: "billing",
      areas: ["billing"],
      poolLabels: ["area:billing"],
      sharedLabels: ["domain:payments"],
    });
    expect(tracker.queries[0]).toEqual({
      withSomeOf: [["area:billing"], ["xs", "small", "medium"]],
    });
    expect(ids(p.candidates)).toEqual(["ENG-1"]);
  });

  it("holds an urgent issue in the pool back rather than ranking it first", async () => {
    const tracker = fakeTracker([
      issue("ENG-1"),
      issue("ENG-2", { priority: 1 }),
    ]);
    const p = await run(tracker, catalog(), P, "billing", opts(), root());
    expect(ids(p.candidates)).toEqual(["ENG-1"]);
    expect(p.excluded.map((e) => [e.identifier, e.reason])).toEqual([
      ["ENG-2", { kind: "urgent" }],
    ]);
  });

  it("resolves a path through the catalog's own globs, normalized to the root", async () => {
    const dir = root("src/search/index");
    const tracker = fakeTracker([
      issue("ENG-1", {
        labels: relabel(base, ["area:billing"], ["area:search"]),
      }),
    ]);
    for (const anchor of [
      "src/search/index",
      "./src/search/index/",
      join(dir, "src/search/index"),
    ]) {
      const p = await run(tracker, catalog(), P, anchor, opts(), dir);
      expect([anchor, p.anchor.kind, p.anchor.input, p.anchor.areas]).toEqual([
        anchor,
        "path",
        "src/search/index",
        ["search"],
      ]);
    }
    expect(normalizeRepoPath("/elsewhere/x", dir)).toBe("/elsewhere/x");
  });

  it("finds a narrower area under a directory that a broader one also holds, and refuses its flag", async () => {
    const dir = root("src/billing/api");
    const message = await refusal(
      run(fakeTracker([]), catalog(), P, "src/billing/api", opts(), dir),
    );
    expect(message).toContain("billing, billing-api");
    expect(message).toContain("api-review");
    expect(message).toContain("/jig:do-item");
  });

  it("finds an area that holds only a deeper part of a directory's subtree, and refuses its flag", async () => {
    const dir = root("src/billing");
    const message = await refusal(
      run(fakeTracker([]), catalog(), P, "src/billing", opts(), dir),
    );
    expect(message).toContain("billing, billing-api");
    expect(message).toContain("api-review");
    const top = await refusal(
      run(fakeTracker([]), catalog(), P, "src", opts(), root("src")),
    );
    expect(top).toContain("billing-api");
  });

  it("tells a glob that can match below a directory from one that cannot", () => {
    for (const [dir, glob, may] of [
      ["src/billing", "src/billing/api/**", true],
      ["src/billing", "src/*/api/**", true],
      ["src/billing", "src/**/x.ts", true],
      ["src/billing", "src/billing/*.ts", true],
      ["src/billing", "src/billing", false],
      ["src/billing", "src/*.ts", false],
      ["src/billing", "src/search/**", false],
      ["src/billing", "{src/billing,lib}/**", true],
      ["", "docs/**", true],
    ] as const)
      expect([dir, glob, globMayMatchUnder(dir, glob)]).toEqual([
        dir,
        glob,
        may,
      ]);
  });

  it("does not widen a path that is a file", async () => {
    const dir = root("src/billing");
    writeFileSync(join(dir, "src/billing/api"), "a file, not a directory\n");
    const p = await run(
      fakeTracker([issue("ENG-1")]),
      catalog(),
      P,
      "src/billing/api",
      opts(),
      dir,
    );
    expect(p.anchor.areas).toEqual(["billing"]);
  });

  it("refuses an area whose own flags make every change there solo-only, before any read", async () => {
    const tracker = fakeTracker([]);
    const message = await refusal(
      run(tracker, catalog(), P, "infra", opts(), root()),
    );
    expect(message).toContain("db-migration");
    expect(tracker.queries).toEqual([]);
  });

  it("refuses an area that no label names", async () => {
    const message = await refusal(
      run(fakeTracker([]), catalog(), P, "docs", opts(), root()),
    );
    expect(message).toContain("no label names docs");
    expect(message).toContain("do_item.agents.codearea_areas");
  });

  it("takes an area's naming label from do_item.agents.codearea_areas when the catalog does not list it", async () => {
    const mapped = policy({
      do_item: { agents: { codearea_areas: { "area:docs": "docs" } } },
    });
    const p = await run(
      fakeTracker([]),
      catalog(),
      mapped,
      "docs",
      opts(),
      root(),
    );
    expect(p.anchor.poolLabels).toEqual(["area:docs"]);
    expect(p.anchor.sharedLabels).toEqual(["domain:payments"]);
  });

  it("queries a configured area-naming label in the configuration's own spelling", async () => {
    const mapped = policy({
      do_item: { agents: { codearea_areas: { "Area:Docs": "docs" } } },
    });
    const docs = issue("ENG-7", {
      labels: relabel(base, ["area:billing"], ["Area:Docs", "domain:payments"]),
    });
    const tracker = fakeTracker([docs]);
    const p = await run(tracker, catalog(), mapped, "docs", opts(), root());
    expect(p.anchor.poolLabels).toEqual(["Area:Docs"]);
    expect(tracker.queries[0]?.withSomeOf[0]).toEqual(["Area:Docs"]);
    expect(ids(p.candidates)).toEqual(["ENG-7"]);
  });

  it("refuses an anchor that matches nothing, naming the areas", async () => {
    const message = await refusal(
      run(fakeTracker([]), catalog(), P, "nowhere/at/all", opts(), root()),
    );
    expect(message).toContain(
      "known areas: billing, billing-api, docs, infra, search",
    );
  });

  it("refuses an area anchor without a catalog", async () => {
    const message = await refusal(
      run(fakeTracker([]), null, P, "billing", opts(), root()),
    );
    expect(message).toContain("drive.change_areas_catalog is not set");
  });
});

describe("issue and epic anchors", () => {
  it("batches a seed's siblings by its area-naming label and keeps the seed first", async () => {
    const seed = issue("ENG-1", {
      labels: relabel(base, ["small"], ["medium"]),
    });
    const tracker = fakeTracker([
      seed,
      issue("ENG-2", { labels: relabel(base, ["small"], ["xs"]) }),
      issue("ENG-3"),
    ]);
    const p = await run(tracker, catalog(), P, "ENG-1", opts(), root());
    expect(p.anchor.kind).toBe("issue");
    expect(p.anchor.poolLabels).toEqual(["area:billing"]);
    expect(p.anchor.sharedLabels).toEqual(["domain:payments"]);
    expect(ids(p.candidates)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
  });

  it("keeps the seed even when cheaper siblings would fill the budget, and warns when it alone is over", async () => {
    const seed = issue("ENG-1", {
      labels: relabel(base, ["small"], ["medium"]),
    });
    const siblings = Array.from({ length: 8 }, (_, i) =>
      issue(`ENG-${i + 2}`, { labels: relabel(base, ["small"], ["xs"]) }),
    );
    const p = await run(
      fakeTracker([seed, ...siblings]),
      catalog(),
      P,
      "ENG-1",
      opts({ budget: 4, limit: 3 }),
      root(),
    );
    expect(ids(p.candidates)[0]).toBe("ENG-1");
    expect(p.candidates).toHaveLength(1);
    expect(p.points).toBe(6);
    expect(p.warnings.join("\n")).toContain(
      "alone costs more than the 4-point budget",
    );
  });

  it("refuses a seed that cannot join a batch, recommending it be worked alone", async () => {
    const cases: [PoolIssue, string][] = [
      [
        issue("ENG-1", { labels: [...base, "hitl:legal"] }),
        "solo-only flag hitl:legal",
      ],
      [issue("ENG-1", { truncated: ["labels"] }), "did not come back in full"],
      [issue("ENG-1", { priority: 1 }), "urgent"],
      [
        issue("ENG-1", { labels: relabel(base, ["small"], ["large"]) }),
        "too large to batch",
      ],
      [issue("ENG-1", { labels: relabel(base, ["bug"]) }), "no type label"],
      [
        issue("ENG-1", {
          labels: relabel(base, ["area:billing"], ["domain:payments"]),
        }),
        "no area-naming label",
      ],
      [
        issue("ENG-1", { hasOpenChildren: true }),
        "open children but no epic label",
      ],
      [
        issue("ENG-1", { state: { id: "d", name: "Done", type: "completed" } }),
        "already Done",
      ],
    ];
    for (const [seed, expected] of cases) {
      const tracker = fakeTracker([seed]);
      const message = await refusal(
        run(tracker, catalog(), P, "ENG-1", opts(), root()),
      );
      expect([expected, message.includes(expected)]).toEqual([expected, true]);
      expect(tracker.queries).toEqual([]);
    }
    expect(
      await refusal(
        run(fakeTracker([]), catalog(), P, "ENG-404", opts(), root()),
      ),
    ).toContain("issue ENG-404 not found");
  });

  it("refuses an urgent epic before reading its children", async () => {
    const epic = issue("ENG-1", {
      labels: ["epic", "area:billing"],
      priority: 1,
      hasOpenChildren: true,
    });
    const tracker = fakeTracker([epic], {
      children: { "ENG-1": [issue("ENG-2")] },
    });
    expect(
      await refusal(run(tracker, catalog(), P, "ENG-1", opts(), root())),
    ).toContain("ENG-1 is urgent");
    expect(tracker.childReads).toEqual([]);
    expect(tracker.queries).toEqual([]);
  });

  it("does not refuse a seed that is not urgent", async () => {
    const tracker = fakeTracker([
      issue("ENG-1", { priority: 2 }),
      issue("ENG-2"),
    ]);
    const p = await run(tracker, catalog(), P, "ENG-1", opts(), root());
    expect(ids(p.candidates)).toEqual(["ENG-1", "ENG-2"]);
  });

  it("names and pins the seed by the tracker's spelling of a key typed in lower case", async () => {
    const seed = issue("ENG-1", {
      labels: relabel(base, ["small"], ["medium"]),
    });
    const siblings = Array.from({ length: 6 }, (_, i) =>
      issue(`ENG-${i + 2}`, { labels: relabel(base, ["small"], ["xs"]) }),
    );
    const p = await run(
      fakeTracker([seed, ...siblings]),
      catalog(),
      P,
      "eng-1",
      opts({ limit: 2 }),
      root(),
    );
    expect(p.anchor.input).toBe("ENG-1");
    expect(ids(p.candidates)[0]).toBe("ENG-1");
    expect(p.candidates).toHaveLength(2);
  });

  it("refuses a seed assigned to someone unless --claimed names it", async () => {
    const seed = issue("ENG-1", {
      assignee: { id: "u1", name: "Me" },
      state: { id: "s-ip", name: "In Progress", type: "started" },
    });
    const tracker = fakeTracker([seed, issue("ENG-2")]);
    expect(
      await refusal(run(tracker, catalog(), P, "ENG-1", opts(), root())),
    ).toContain("Pass --claimed ENG-1");
    const p = await run(
      tracker,
      catalog(),
      P,
      "ENG-1",
      opts({ claimed: new Set(["ENG-1"]) }),
      root(),
    );
    expect(ids(p.candidates)).toEqual(["ENG-1", "ENG-2"]);
  });

  it("reads an epic's open children, with no gap read, and holds back a child with no size", async () => {
    const epic = issue("ENG-1", {
      labels: ["epic", "area:billing", "domain:payments"],
      hasOpenChildren: true,
    });
    const tracker = fakeTracker([epic], {
      children: {
        "ENG-1": [
          issue("ENG-2"),
          issue("ENG-3", { labels: relabel(base, ["small"]) }),
          issue("ENG-4", {
            state: { id: "d", name: "Done", type: "completed" },
          }),
        ],
      },
    });
    const p = await run(tracker, catalog(), P, "ENG-1", opts(), root());
    expect(p.anchor.kind).toBe("epic");
    expect(p.anchor.sharedLabels).toEqual(["area:billing", "domain:payments"]);
    expect(tracker.childReads).toEqual(["ENG-1"]);
    expect(tracker.queries).toEqual([]);
    expect(ids(p.candidates)).toEqual(["ENG-2"]);
    expect(p.excluded).toEqual([
      {
        identifier: "ENG-3",
        title: "Fix ENG-3",
        reason: { kind: "not-batchable-size", size: null },
      },
    ]);
    expect(p.labellingGaps).toEqual([]);
  });
});

describe("epic anchors and context labels", () => {
  it("holds back a child whose only context label is unknown, as the eligibility mode does", async () => {
    const epic = issue("ENG-1", { labels: ["epic"], hasOpenChildren: true });
    const child = issue("ENG-2", {
      labels: ["small", "web", "bug", "agent:bogus"],
    });
    const p = await run(
      fakeTracker([epic], { children: { "ENG-1": [child] } }),
      catalog(),
      P,
      "ENG-1",
      opts(),
      root(),
    );
    const reason = {
      kind: "unknown-context-label" as const,
      labels: ["agent:bogus"],
    };
    expect(p.excluded.map((e) => e.reason)).toEqual([reason]);
    expect(
      eligibilityReport([child], P, new Set()).verdicts[0]?.reason,
    ).toEqual(reason);
  });

  it("ranks on the epic's known area labels only", async () => {
    const epic = issue("ENG-1", {
      labels: ["epic", "area:billing", "area:bilingg"],
      hasOpenChildren: true,
    });
    const p = await run(
      fakeTracker([epic], { children: { "ENG-1": [issue("ENG-2")] } }),
      catalog(),
      P,
      "ENG-1",
      opts(),
      root(),
    );
    expect(p.anchor.sharedLabels).toEqual(["area:billing"]);
  });
});

describe("issues in a flagged area", () => {
  const apiIssue = (key: string) =>
    issue(key, {
      labels: relabel(base, ["area:billing"], ["area:billing-api"]),
    });

  it("refuses an issue anchor whose area carries a flag the issue lacks", async () => {
    const tracker = fakeTracker([apiIssue("ENG-1")]);
    const message = await refusal(
      run(tracker, catalog(), P, "ENG-1", opts(), root()),
    );
    expect(message).toContain("billing-api");
    expect(message).toContain("api-review");
    expect(tracker.queries).toEqual([]);
  });

  it("holds back an epic's child and an eligibility-mode issue in such an area", async () => {
    const epic = issue("ENG-1", { labels: ["epic"], hasOpenChildren: true });
    const child = apiIssue("ENG-2");
    const p = await run(
      fakeTracker([epic], { children: { "ENG-1": [child] } }),
      catalog(),
      P,
      "ENG-1",
      opts(),
      root(),
    );
    const reason = {
      kind: "solo-area" as const,
      area: "billing-api",
      flags: ["api-review"],
    };
    expect(p.excluded.map((e) => e.reason)).toEqual([reason]);
    const report = eligibilityReport([child], P, new Set());
    expect(report.verdicts[0]?.reason).toEqual(reason);
    expect(report.policy.areaFlags).toEqual({
      "billing-api": ["api-review"],
      infra: ["db-migration"],
    });
  });
});

describe("labelling gaps", () => {
  it("reports issues with no size label, apart from the held-back list", async () => {
    const tracker = fakeTracker([
      issue("ENG-1"),
      issue("ENG-2", { labels: relabel(base, ["small"]) }),
      issue("ENG-3", { labels: relabel(base, ["small", "web"], ["api"]) }),
      issue("ENG-4", { labels: relabel(base, ["small"], ["large"]) }),
      issue("ENG-5", {
        labels: relabel(base, ["small"]),
        truncated: ["labels"],
      }),
    ]);
    const p = await run(tracker, catalog(), P, "billing", opts(), root());
    expect(tracker.queries[1]).toEqual({
      withSomeOf: [["area:billing"]],
      withNoneOf: ["xs", "small", "medium", "large", "xl"],
    });
    expect(ids(p.labellingGaps)).toEqual(["ENG-2"]);
    expect(ids(p.excluded)).toEqual([]);
    expect(p.warnings.join("\n")).toContain(
      "1 issue(s) matching the anchor came back with truncated labels",
    );
  });

  it("drops a gap that carries this repository's label beside another's", async () => {
    const tracker = fakeTracker([
      issue("ENG-1", { labels: relabel(base, ["small"], ["api"]) }),
      issue("ENG-2", { labels: relabel(base, ["small", "web"]) }),
    ]);
    const p = await run(tracker, catalog(), P, "billing", opts(), root());
    expect(ids(p.labellingGaps)).toEqual(["ENG-2"]);
  });

  it("keeps the proposal when the gap read fails, and says gaps went unreported", async () => {
    const tracker = fakeTracker([issue("ENG-1")], { failGapRead: true });
    const p = await run(tracker, catalog(), P, "billing", opts(), root());
    expect(ids(p.candidates)).toEqual(["ENG-1"]);
    expect(p.warnings.join("\n")).toContain("the labelling-gap read failed");
  });

  it("does not report gaps without work_batch.sizes, and says why", async () => {
    const noSizes = policy({ work_batch: {} });
    const tracker = fakeTracker([issue("ENG-1")]);
    const p = await run(tracker, catalog(), noSizes, "billing", opts(), root());
    expect(tracker.queries).toHaveLength(1);
    expect(p.warnings.join("\n")).toContain("labelling gaps are not reported");
  });
});

describe("the eligibility mode", () => {
  const pool = [
    issue("ENG-1"),
    issue("ENG-2", { labels: [...base, "hitl"] }),
    issue("ENG-3", { labels: relabel(base, ["small"], ["large"]) }),
    issue("ENG-4", { truncated: ["labels"] }),
    issue("ENG-5", { assignee: { id: "u", name: "Sam" } }),
    issue("ENG-6", { labels: relabel(base, ["small"], ["medium"]) }),
    issue("ENG-7", { labels: relabel(base, ["bug"], ["feature", "chore"]) }),
  ];

  it("returns the verdicts the proposal reaches for the same issues", async () => {
    // An epic's children reach the proposal's eligibility check whatever
    // their size, so every issue here is judged by both.
    const epic = issue("ENG-100", { labels: ["epic"], hasOpenChildren: true });
    const tracker = fakeTracker([epic], { children: { "ENG-100": pool } });
    const proposal = await run(
      tracker,
      catalog(),
      P,
      "ENG-100",
      opts({ limit: 1 }),
      root(),
    );
    const report = eligibilityReport(pool, P, new Set());
    const held = new Map(
      proposal.excluded.map((e) => [e.identifier, e.reason]),
    );
    for (const v of report.verdicts) {
      expect([v.identifier, v.eligible]).toEqual([
        v.identifier,
        !held.has(v.identifier),
      ]);
      expect([v.identifier, v.reason]).toEqual([
        v.identifier,
        held.get(v.identifier) ?? null,
      ]);
    }
    // Every eligible issue is in the proposal or its overflow.
    expect(report.verdicts.filter((v) => v.eligible)).toHaveLength(
      proposal.candidates.length + proposal.overflow,
    );
  });

  it("reports the effective policy and each eligible issue's size and points", () => {
    const report = eligibilityReport(pool, P, new Set(["ENG-5"]));
    expect(report.version).toBe(1);
    expect(report.policy.soloFlags).toEqual([
      "api-review",
      "db-migration",
      "hitl",
      "manual-ops",
    ]);
    expect(report.policy.batchSizes).toEqual(["xs", "small", "medium"]);
    expect(report.policy.sizePoints).toEqual({ xs: 1, small: 2, medium: 6 });
    expect(report.policy.pointBudget).toBe(16);
    expect(report.policy.maxItems).toBe(6);
    const five = report.verdicts.find((v) => v.identifier === "ENG-5");
    expect(five).toEqual({
      identifier: "ENG-5",
      eligible: true,
      size: "small",
      points: 2,
      reason: null,
      message: null,
    });
    const two = report.verdicts.find((v) => v.identifier === "ENG-2");
    expect(two?.message).toBe("solo-only: carries `hitl`");
  });

  it("refuses input that omits a field rather than reading it as complete", () => {
    const { truncated: _, ...partial } = issue("ENG-1");
    expect(() => parsePoolIssues([partial])).toThrow(
      "truncated must be a list",
    );
    const { hasOpenChildren: __, ...childless } = issue("ENG-2");
    expect(() => parsePoolIssues([childless])).toThrow("hasOpenChildren");
    expect(() => parsePoolIssues({ issues: [] })).toThrow("JSON array");
    expect(parsePoolIssues(JSON.parse(JSON.stringify(pool)))).toEqual(pool);
  });
});

describe("the table", () => {
  const candidate = (over: Partial<Candidate> = {}): Candidate => ({
    identifier: "ENG-1",
    title: "Fix ENG-1",
    url: null,
    size: "small",
    points: 2,
    priority: 3,
    createdAt: "2026-01-01T00:00:00Z",
    assignee: { id: "u1", name: "Sam" },
    state: { id: "s-b", name: "Backlog", type: "backlog" },
    labels: ["area:billing", "bug", "domain:payments", "small", "web"],
    score: 1,
    reasons: ["small (+1)"],
    ...over,
  });

  it("prints every field the claim re-check compares, ids beside names", () => {
    expect(REVALIDATION_FIELD_KEYS).toEqual([
      "state",
      "assignee",
      "priority",
      "size",
      "type",
      "repo",
      "context",
    ]);
    expect(revalidationLine(candidate(), P)).toBe(
      "state: Backlog <s-b> | assignee: Sam <u1> | priority: 3 (medium) | size: small | type: bug | repo: web | context: area:billing, domain:payments",
    );
    expect(
      revalidationLine(candidate({ assignee: null, labels: ["small"] }), P),
    ).toBe(
      "state: Backlog <s-b> | assignee: (unassigned) | priority: 3 (medium) | size: small | type: (none) | repo: (none) | context: (none)",
    );
  });

  it("differs when only the priority, size, type or context changes, and sorts context", () => {
    const a = revalidationLine(candidate(), P);
    for (const changed of [
      candidate({ priority: 1 }),
      candidate({ size: "xs" }),
      candidate({
        labels: ["area:billing", "feature", "domain:payments", "small", "web"],
      }),
      candidate({ labels: ["area:billing", "bug", "small", "web"] }),
    ])
      expect(revalidationLine(changed, P)).not.toBe(a);
    expect(
      revalidationLine(
        candidate({
          labels: ["domain:payments", "web", "small", "bug", "area:billing"],
        }),
        P,
      ),
    ).toBe(a);
  });

  it("differs when only an id changes under the same name", () => {
    const a = revalidationLine(candidate(), P);
    expect(
      revalidationLine(
        candidate({ state: { id: "s-x", name: "Backlog", type: "backlog" } }),
        P,
      ),
    ).not.toBe(a);
    expect(
      revalidationLine(candidate({ assignee: { id: "u2", name: "Sam" } }), P),
    ).not.toBe(a);
  });

  it("matches the field list SKILL.md tells the agent to compare", () => {
    const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");
    expect(skill).toContain(
      REVALIDATION_FIELD_KEYS.map((k) => `\`${k}\``).join(", "),
    );
  });

  function proposal(over: Partial<Proposal> = {}): Proposal {
    return {
      version: 1,
      anchor: {
        kind: "area",
        input: "billing",
        areas: ["billing"],
        poolLabels: ["area:billing"],
        sharedLabels: [],
      },
      limit: 6,
      budget: 16,
      points: 2,
      candidates: [candidate()],
      excluded: [],
      labellingGaps: [],
      overflow: 0,
      warnings: [],
      ...over,
    };
  }

  it("asks for a verdict under each medium", () => {
    const text = renderTable(
      proposal({
        candidates: [
          candidate({ identifier: "ENG-2", size: "medium", points: 6 }),
        ],
      }),
      P,
    );
    expect(text).toContain("medium: step 2 verdict required");
    expect(renderTable(proposal(), P)).not.toContain("verdict required");
  });

  it("strips control characters from every tracker text it prints", () => {
    const text = renderTable(
      proposal({
        candidates: [
          candidate({
            title: "evil\u001b[2J title",
            state: { id: "s\u0007", name: "Back\u001blog", type: "backlog" },
          }),
        ],
        excluded: [
          {
            identifier: "ENG-9",
            title: "x",
            reason: { kind: "already-started", state: "In\u001b[1A Progress" },
          },
        ],
        labellingGaps: [
          { identifier: "ENG-8", title: "gap\u009b", url: null, labels: [] },
        ],
        warnings: ["warn\u001b[0m"],
      }),
      P,
    );
    // Every control character but the newline that separates the lines.
    const control = [...text].filter((c) => {
      const n = c.charCodeAt(0);
      return c !== "\n" && (n <= 0x1f || (n >= 0x7f && n <= 0x9f));
    });
    expect(control).toEqual([]);
    expect(text).toContain("evil[2J title");
  });

  it("names what will hold a labelling gap back once it is sized", () => {
    const text = renderTable(
      proposal({
        labellingGaps: [
          {
            identifier: "ENG-7",
            title: "flagged",
            url: null,
            labels: ["hitl:legal", "area:billing"],
          },
          {
            identifier: "ENG-8",
            title: "plain",
            url: null,
            labels: ["area:billing"],
          },
        ],
      }),
      P,
    );
    expect(text).toContain("ENG-7  flagged  [also: hitl:legal]");
    expect(text).toMatch(/ENG-8 {2}plain$/m);
  });

  it("says when the batch is empty, and how much was left out", () => {
    const text = renderTable(
      proposal({ candidates: [], points: 0, overflow: 3 }),
      P,
    );
    expect(text).toContain("No batchable candidates.");
    expect(text).toContain("3 further eligible issue(s)");
  });
});

describe("assembly", () => {
  it("never drops an eligible issue silently: each is proposed or counted as overflow", () => {
    const pool = Array.from({ length: 10 }, (_, i) => issue(`ENG-${i + 1}`));
    const anchor = {
      kind: "area" as const,
      input: "billing",
      areas: ["billing"],
      poolLabels: ["area:billing"],
      sharedLabels: [],
    };
    const p = buildProposal(anchor, pool, P, opts(), [], []);
    expect(p.candidates.length + p.overflow).toBe(10);
    expect(p.candidates).toHaveLength(6);
  });
});
