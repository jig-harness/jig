/**
 * fleet-health.test.ts — the ceremony-versus-progress sensor.
 *
 * Pinned, in order of how badly a silent regression would mislead:
 *
 *  - the KNOWN POSITIVES, as fixtures: a five-PR follow-up chain must read as
 *    depth ≥ 2 and a carousel-shaped PR must read as a carousel. If the
 *    sensor does not flag them the definitions are wrong, so a test that does
 *    not build them would let a retune quietly un-flag them;
 *  - the ZERO-PROGRESS rule: a nonzero ceremony count against no progress raises
 *    at maximum severity and never propagates NaN/Infinity, while zero against
 *    zero raises nothing;
 *  - the LIFECYCLE: a sensor's own comment must be recognised as its own
 *    presentation (else it re-comments forever), and a cooldown must end;
 *  - the SHIPPED config: it parses, and every product area it names exists in
 *    the change-area catalog (a rename must not silently shrink progress);
 *  - the composition `main` runs, against injected deps, including the
 *    budget refusal and the failure breaker.
 *
 * No network: everything is pure over fixtures.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseTrackerConfig } from "../../do-issue/scripts/lib/tracker/config.ts";
import { linearTracker } from "../../do-issue/scripts/lib/tracker/linear.ts";
import {
  BudgetError,
  MIN_GRAPHQL_BUDGET,
  type PostDeps,
  postSuspicions,
  type RunDeps,
  runFleetHealth,
} from "../scripts/fleet-health.ts";
import {
  activeSignals,
  buildReport,
  type CommentFact,
  ceremonyRatioSignal,
  computeEpicUnits,
  type DepthResult,
  deliveryShareSignal,
  deriveLifecycle,
  epicOf,
  epicsOfPr,
  followupDepth,
  type IssueFact,
  originPrOf,
  type PrFact,
  parseIssueRefs,
  presentable,
  prWarnings,
  renderReport,
  reviewCarouselSignal,
  stuckEpicSignal,
  suspicionComment,
  suspicionMarker,
  type UnitsInput,
  unattributedCeremony,
  unparsedDiagnoses,
} from "../scripts/lib/fleet-health.ts";
import {
  type ConfigContext,
  type FleetHealthConfig,
  parseConfig,
} from "../scripts/lib/fleet-health-config.ts";
import {
  loadCatalogFile,
  type PrListing,
} from "../scripts/lib/fleet-health-sources.ts";

const DAY = 86_400_000;
const UNTIL = Date.parse("2026-09-15T00:00:00Z");
const WIN = { sinceMs: UNTIL - 14 * DAY, untilMs: UNTIL };
const IN = "2026-09-10T12:00:00Z";
const BEFORE = "2026-08-01T12:00:00Z";

/** The consumer's fleet-health configuration and catalog, as fixtures. */
const FIXTURES = join(import.meta.dir, "fixtures");
const CONTEXT: ConfigContext = {
  root: FIXTURES,
  teamKey: "ENG",
  epicLabel: "epic",
  followupLabel: "follow-up",
  catalogPath: join(FIXTURES, "change-areas-catalog.yaml"),
  configPath: join(FIXTURES, "fleet-health.yaml"),
};

function cfgWith(
  patch: (raw: Record<string, unknown>) => void,
): FleetHealthConfig {
  const raw = yaml.load(
    readFileSync(join(FIXTURES, "fleet-health.yaml"), "utf8"),
  ) as Record<string, unknown>;
  patch(raw);
  return parseConfig(raw, CONTEXT);
}
const CFG = cfgWith(() => undefined);

/** A tracker that is present; the tests inject every read it would make. */
const STUB_TRACKER = linearTracker({
  team: "ENG",
  states: parseTrackerConfig({}).states,
  transport: async () => ({}),
});

function issue(id: string, over: Partial<IssueFact> = {}): IssueFact {
  return {
    id,
    title: `title ${id}`,
    labels: [],
    createdAt: IN,
    completedAt: null,
    stateType: "started",
    description: "",
    ancestors: [{ id: "ENG-1", labels: ["epic"] }],
    ...over,
  };
}

/** Follow-up-walk dependencies over a fixed PR → issues map; an absent PR reads as unreadable. */
function depsOf(
  byPr: ReadonlyMap<number, IssueFact[]>,
  onRead: (pr: number) => void = () => undefined,
) {
  return {
    issuesOfPr: async (n: number) => {
      onRead(n);
      const issues = byPr.get(n);
      return issues === undefined ? null : { issues, complete: true };
    },
  };
}

function pr(number: number, over: Partial<PrFact> = {}): PrFact {
  return {
    number,
    title: `pr ${number}`,
    state: "MERGED",
    mergedAt: IN,
    issueRefs: [],
    rounds: [],
    postReviewShare: null,
    postReviewAdditions: 0,
    openingAdditions: 0,
    threads: { total: 0, answered: 0, accepted: 0 },
    productPr: true,
    ...over,
  };
}

function units(over: Partial<UnitsInput> = {}): UnitsInput {
  return {
    cfg: CFG,
    window: WIN,
    prs: [],
    issues: new Map(),
    followups: [],
    sdlcIssues: [],
    completed: [],
    acceptedEpics: new Set(),
    ...over,
  };
}

describe("the fleet-health config", () => {
  it("parses", () => {
    expect(CFG.window.days).toBe(14);
  });

  it("names only product areas the change-area catalog has", () => {
    const catalog = loadCatalogFile(CONTEXT.catalogPath as string);
    const missing = CFG.progress.productAreas.filter((a) => !catalog.has(a));
    expect(missing).toEqual([]);
  });

  it("rejects a key the sensor does not read, so a dead knob cannot look like a retune", () => {
    expect(() =>
      cfgWith((r) => ((r.window as Record<string, unknown>).hours = 3)),
    ).toThrow(/not a key the sensor reads/);
  });

  it("rejects a high_at below suspect_at", () => {
    expect(() =>
      cfgWith((r) => {
        const s = (r.signals as Record<string, Record<string, number>>)
          .ceremony_ratio as Record<string, number>;
        s.high_at = 0.5;
        s.suspect_at = 2;
      }),
    ).toThrow(/high_at/);
  });

  it("rejects a carousel min_rounds at or below free_rounds, which the sampler would never reach", () => {
    expect(() =>
      cfgWith((r) => {
        const free = (r.ceremony as Record<string, number>)
          .free_rounds as number;
        const c = (r.signals as Record<string, Record<string, number>>)
          .review_carousel as Record<string, number>;
        c.min_rounds = free;
        c.high_rounds = free;
      }),
    ).toThrow(/min_rounds/);
  });

  it("states why each unmeasured ceremony unit cannot be measured", () => {
    expect(() =>
      cfgWith(
        (r) =>
          ((r.ceremony as Record<string, Record<string, string>>).unmeasured = {
            handoffs: "",
          }),
      ),
    ).toThrow(/why it cannot be measured/);
  });
});

describe("issue references and follow-up origins", () => {
  it("reads a trailer inside a table cell, which is where batched PRs put them", () => {
    expect(
      parseIssueRefs(
        "| Closes ENG-7905 | `86e129d` | x |\n| Closes ENG-7914 | y |",
      ),
    ).toEqual(["ENG-7905", "ENG-7914"]);
  });

  it("reads References and comma-joined lists, and ignores a bare mention", () => {
    expect(
      parseIssueRefs(
        "References: ENG-7488 (fractal SDLC)\nCloses ENG-1, ENG-2 and ENG-3",
      ),
    ).toEqual(["ENG-7488", "ENG-1", "ENG-2", "ENG-3"]);
    expect(
      parseIssueRefs("Scoped against: ENG-6726 (review-loop economy)"),
    ).toEqual([]);
  });

  it("reads whitespace-separated ids after one keyword, the repository trailer form", () => {
    expect(parseIssueRefs("References: ENG-5291 ENG-4734")).toEqual([
      "ENG-5291",
      "ENG-4734",
    ]);
    expect(parseIssueRefs("Closes ENG-1\nENG-2, ENG-3 & ENG-4")).toEqual([
      "ENG-1",
      "ENG-2",
      "ENG-3",
      "ENG-4",
    ]);
    // With the consumer's team key, another team's key is not a reference.
    // Another team's key ends the trailer like prose does.
    expect(parseIssueRefs("Closes ENG-1, OPS-2 & ENG-3", "ENG")).toEqual([
      "ENG-1",
    ]);
    expect(parseIssueRefs("closes eng-3", "ENG")).toEqual(["ENG-3"]);
    // A second keyword still starts its own match, and prose between ids ends one.
    expect(parseIssueRefs("Closes ENG-1 and see ENG-2")).toEqual(["ENG-1"]);
  });

  it("takes the origin PR from a batch title, then from the description", () => {
    expect(
      originPrOf({ title: "PR #4985 docs review follow-ups", description: "" }),
    ).toBe(4985);
    expect(
      originPrOf({
        title: "runExecutesCommand: negation on an enclosing pipeline",
        description:
          "Review deferral from PR example-org/example-repo#4666 round 21, originating issue ENG-7866.",
      }),
    ).toBe(4666);
    expect(
      originPrOf({
        title: "x",
        description:
          "see https://github.com/example-org/example-repo/pull/4645 round 9",
      }),
    ).toBe(4645);
    expect(
      originPrOf({ title: "x", description: "no pull request named" }),
    ).toBeNull();
  });

  it("attributes a PR to the epic of EVERY issue it names", () => {
    const issues = new Map([
      [
        "ENG-2",
        issue("ENG-2", { ancestors: [{ id: "ENG-100", labels: ["epic"] }] }),
      ],
      [
        "ENG-3",
        issue("ENG-3", { ancestors: [{ id: "ENG-200", labels: ["epic"] }] }),
      ],
      ["ENG-4", issue("ENG-4", { ancestors: [] })],
    ]);
    expect(
      epicsOfPr({ issueRefs: ["ENG-2", "ENG-3", "ENG-4", "ENG-9"] }, issues),
    ).toEqual(["ENG-100", "ENG-200"]);
    expect(
      epicOf(
        issue("ENG-5", {
          ancestors: [
            { id: "A", labels: [] },
            { id: "B", labels: ["epic"] },
          ],
        }),
      ),
    ).toBe("B");
  });
});

describe("progress and ceremony units", () => {
  const issues = new Map([
    ["ENG-2", issue("ENG-2")],
    [
      "ENG-3",
      issue("ENG-3", { ancestors: [{ id: "ENG-9", labels: ["epic"] }] }),
    ],
  ]);

  it("credits a batched PR to each of its epics, and a PR naming no epic to none", () => {
    const u = computeEpicUnits(
      units({
        issues,
        prs: [
          pr(10, { issueRefs: ["ENG-2", "ENG-3"] }),
          pr(11, { issueRefs: ["ENG-404"] }),
        ],
      }),
    );
    expect(u.get("ENG-1")?.progress.mergedProductPrs).toEqual([10]);
    expect(u.get("ENG-9")?.progress.mergedProductPrs).toEqual([10]);
    expect(u.size).toBe(2);
  });

  it("counts only a merged PR that touches a product area, inside the window", () => {
    const u = computeEpicUnits(
      units({
        issues,
        prs: [
          pr(1, { issueRefs: ["ENG-2"], productPr: false }),
          pr(2, { issueRefs: ["ENG-2"], productPr: null }),
          pr(3, { issueRefs: ["ENG-2"], mergedAt: BEFORE }),
          pr(4, { issueRefs: ["ENG-2"], state: "CLOSED", mergedAt: null }),
          pr(5, { issueRefs: ["ENG-2"] }),
        ],
      }),
    );
    expect(u.get("ENG-1")?.progress.mergedProductPrs).toEqual([5]);
  });

  it("charges only bot-reviewed heads past free_rounds whose review landed in the window", () => {
    const rounds = [BEFORE, BEFORE, BEFORE, BEFORE, IN, IN]; // rounds 5 and 6 are in the window
    const u = computeEpicUnits(
      units({ issues, prs: [pr(7, { issueRefs: ["ENG-2"], rounds })] }),
    );
    expect(u.get("ENG-1")?.ceremony.roundsBeyondFree).toEqual([
      { pr: 7, rounds: 2 },
    ]);
    // round 4 was in window but round ≤ free_rounds is free
    const free = computeEpicUnits(
      units({
        issues,
        prs: [pr(8, { issueRefs: ["ENG-2"], rounds: [IN, IN, IN] })],
      }),
    );
    expect(free.get("ENG-1")?.ceremony.roundsBeyondFree).toEqual([]);
  });

  it("counts an issue that is both a follow-up and a delivery-system issue ONCE", () => {
    const both = issue("ENG-50", { labels: ["follow-up", "delivery-system"] });
    const sdlcOnly = issue("ENG-51", { labels: ["delivery-system"] });
    const u = computeEpicUnits(
      units({ followups: [both], sdlcIssues: [both, sdlcOnly] }),
    );
    expect(u.get("ENG-1")?.ceremony.followupsMinted).toEqual(["ENG-50"]);
    expect(u.get("ENG-1")?.ceremony.sdlcIssuesOpened).toEqual(["ENG-51"]);
    expect(u.get("ENG-1")?.ceremony.weighted).toBe(2);
  });

  it("counts closed issues as criteria, but never a follow-up or another epic", () => {
    const done = (id: string, labels: string[] = []) =>
      issue(id, { labels, stateType: "completed", completedAt: IN });
    const u = computeEpicUnits(
      units({
        completed: [
          done("ENG-60"),
          done("ENG-61", ["follow-up"]),
          done("ENG-62", ["epic"]),
          issue("ENG-63", { stateType: "completed", completedAt: BEFORE }),
        ],
      }),
    );
    expect(u.get("ENG-1")?.progress.criteriaClosed).toEqual(["ENG-60"]);
  });

  it("lets the three progress kinds co-occur and does not deduplicate them", () => {
    const u = computeEpicUnits(
      units({
        issues,
        prs: [pr(20, { issueRefs: ["ENG-2"] })],
        completed: [
          issue("ENG-70", { stateType: "completed", completedAt: IN }),
        ],
        acceptedEpics: new Set(["ENG-1"]),
      }),
    );
    expect(u.get("ENG-1")?.progress.weighted).toBe(3);
  });
});

describe("ceremony ratio", () => {
  function epicUnits(ceremony: number, progress: number) {
    return {
      epic: "ENG-1",
      progress: {
        mergedProductPrs: [],
        criteriaClosed: [],
        accepted: false,
        weighted: progress,
      },
      ceremony: {
        roundsBeyondFree: [],
        followupsMinted: [],
        sdlcIssuesOpened: [],
        weighted: ceremony,
      },
    };
  }

  it("raises nothing when both are zero", () => {
    expect(ceremonyRatioSignal(epicUnits(0, 0), CFG)).toBeNull();
  });

  it("raises at MAXIMUM against zero progress, with no NaN or Infinity anywhere", () => {
    const s = ceremonyRatioSignal(
      epicUnits(CFG.signals.ceremonyRatio.minCeremony, 0),
      CFG,
    );
    expect(s?.severity).toBe("maximum");
    expect(s?.value).toBeNull();
    expect(JSON.stringify(s)).not.toMatch(/NaN|Infinity/);
  });

  it("grades a finite ratio by suspect_at and high_at", () => {
    const { suspectAt, highAt } = CFG.signals.ceremonyRatio;
    expect(
      ceremonyRatioSignal(epicUnits(suspectAt * 10 - 1, 10), CFG)?.severity,
    ).toBeNull();
    expect(
      ceremonyRatioSignal(epicUnits(suspectAt * 10, 10), CFG)?.severity,
    ).toBe("elevated");
    expect(ceremonyRatioSignal(epicUnits(highAt * 10, 10), CFG)?.severity).toBe(
      "high",
    );
  });

  it("honours min_ceremony as a floor, including against zero progress", () => {
    const floor = CFG.signals.ceremonyRatio.minCeremony;
    expect(
      ceremonyRatioSignal(epicUnits(floor - 1, 0), CFG)?.severity,
    ).toBeNull();
    expect(ceremonyRatioSignal(epicUnits(floor, 0), CFG)?.severity).toBe(
      "maximum",
    );
    // the plan's rule as literally written — any nonzero ceremony — is one config edit away
    const literal = cfgWith((r) => {
      (
        (r.signals as Record<string, Record<string, number>>)
          .ceremony_ratio as Record<string, number>
      ).min_ceremony = 1;
    });
    expect(ceremonyRatioSignal(epicUnits(1, 0), literal)?.severity).toBe(
      "maximum",
    );
  });

  it("says the ratio is a lower bound on ceremony", () => {
    expect(
      ceremonyRatioSignal(epicUnits(1, 0), CFG)?.evidence.join("\n"),
    ).toMatch(/lower bound/);
  });
});

describe("follow-up depth — a recorded five-PR chain", () => {
  // #4627 closes an ordinary issue; #4641 closes follow-ups raised on #4627;
  // #4645 on #4641; #4666 on #4645; #4738 on #4666. Depth of #4738 is 4
  // (four links).
  const followup = (id: string, origin: number) =>
    issue(id, {
      labels: ["follow-up"],
      description: `Review deferral from PR example-org/example-repo#${origin} round 9.`,
    });
  const byPr = new Map<number, IssueFact[]>([
    [4738, [followup("ENG-7905", 4666), followup("ENG-7914", 4666)]],
    [
      4666,
      [
        issue("ENG-7850"),
        followup("ENG-7861", 4645),
        followup("ENG-7866", 4645),
      ],
    ],
    [4645, [issue("ENG-7845"), followup("ENG-7846", 4641)]],
    [4641, [issue("ENG-7840"), followup("ENG-7841", 4627)]],
    [4627, [issue("ENG-7830")]],
  ]);
  const deps = depsOf(byPr);

  it("walks #4738 ← #4666 ← #4645 ← #4641 ← #4627 to depth 4 and raises at the configured threshold", async () => {
    const d = await followupDepth(4738, deps, 6);
    expect(d.depth).toBe(4);
    expect(d.chain).toEqual([4738, 4666, 4645, 4641, 4627]);
    expect(d.truncated).toBe(false);
    expect(CFG.signals.followupDepth.suspectAt).toBeLessThanOrEqual(d.depth);
  });

  it("gives a PR that closes no follow-up depth 0", async () => {
    expect((await followupDepth(4627, deps, 6)).depth).toBe(0);
  });

  it("follows the deepest lineage when follow-ups point at different origins", async () => {
    const m = new Map(byPr);
    m.set(4738, [followup("ENG-1", 4645), followup("ENG-2", 4666)]);
    const d = await followupDepth(4738, depsOf(m), 6);
    expect(d.chain).toEqual([4738, 4666, 4645, 4641, 4627]);
  });

  it("stops at a cycle and at maxWalk, and says so", async () => {
    const loop = new Map<number, IssueFact[]>([
      [101, [followup("A", 102)]],
      [102, [followup("B", 101)]],
    ]);
    expect((await followupDepth(101, depsOf(loop), 6)).depth).toBe(1);
    const short = await followupDepth(4738, deps, 1);
    expect(short.truncated).toBe(true);
    expect(short.depth).toBe(1);
  });

  it("marks an unreadable PR as truncated — a degradation — not as depth 0", async () => {
    const r = await followupDepth(9, { issuesOfPr: async () => null }, 6);
    expect(r.truncated).toBe(true);
    expect(r.originless).toBe(false);
  });

  it("marks a follow-up that records no origin PR as originless — a standing caveat, not a gap", async () => {
    const orphan = issue("ENG-8", {
      labels: ["follow-up"],
      description: "filed from an issue, no pull request named",
    });
    const r = await followupDepth(
      9,
      { issuesOfPr: async () => ({ issues: [orphan], complete: true }) },
      6,
    );
    expect(r.originless).toBe(true);
    expect(r.truncated).toBe(false);
  });
});

describe("review carousel — a recorded carousel-shaped PR", () => {
  // A measured shape: 12 bot-reviewed heads, 45 threads (42 accepted), and
  // 0.452 of its authored added lines landed after the first review began.
  // If the sensor does not flag it the definitions are wrong, so the
  // configured thresholds are pinned against these numbers — a retune that
  // un-flags it fails here.
  const plan = pr(5032, {
    rounds: Array.from({ length: 12 }, () => IN),
    postReviewShare: 0.4522388,
    postReviewAdditions: 455,
    openingAdditions: 551,
    threads: { total: 45, answered: 45, accepted: 42 },
  });

  it("flags the recorded shape under the configured thresholds", () => {
    const s = reviewCarouselSignal(plan, [], CFG);
    expect(s?.severity).toBe("elevated");
    expect(s?.evidence.join("\n")).toMatch(/temporal, not causal/);
  });

  it("grades the worst of them high, at the configured round count", () => {
    const many = {
      ...plan,
      rounds: Array.from(
        { length: CFG.signals.reviewCarousel.highRounds },
        () => IN,
      ),
    };
    expect(reviewCarouselSignal(many, [], CFG)?.severity).toBe("high");
  });

  it("does not flag few rounds, or a low post-review share, or an unmeasured one", () => {
    expect(reviewCarouselSignal({ ...plan, rounds: [IN] }, [], CFG)).toBeNull();
    expect(
      reviewCarouselSignal({ ...plan, postReviewShare: 0.01 }, [], CFG)
        ?.severity,
    ).toBeNull();
    expect(
      reviewCarouselSignal({ ...plan, postReviewShare: null }, [], CFG)
        ?.severity,
    ).toBeNull();
  });
});

describe("delivery-system share", () => {
  it("is a lower bound with a stated upper bound, and is reported not raised with no threshold", () => {
    const s = deliveryShareSignal(
      {
        totalLines: 1000,
        deliveryLines: 300,
        unclaimedSkillLines: 200,
        prs: 4,
      },
      CFG,
    );
    expect(s?.value).toBeCloseTo(0.3);
    expect(s?.headline).toMatch(/30\.0%/);
    expect(s?.headline).toMatch(/50\.0%/);
    expect(CFG.signals.deliverySystemShare.suspectAt).toBeNull();
    expect(s?.severity).toBeNull();
  });

  it("raises once a threshold is configured", () => {
    const cfg = cfgWith((r) => {
      (
        (r.signals as Record<string, Record<string, number>>)
          .delivery_system_share as Record<string, number>
      ).suspect_at = 0.25;
    });
    expect(
      deliveryShareSignal(
        {
          totalLines: 1000,
          deliveryLines: 300,
          unclaimedSkillLines: 0,
          prs: 1,
        },
        cfg,
      )?.severity,
    ).toBe("elevated");
  });

  it("says nothing about an empty window", () => {
    expect(
      deliveryShareSignal(
        { totalLines: 0, deliveryLines: 0, unclaimedSkillLines: 0, prs: 0 },
        CFG,
      ),
    ).toBeNull();
  });
});

describe("signal lifecycle", () => {
  const NOW = Date.parse("2026-09-15T00:00:00Z");
  const at = (d: string): string => `2026-09-${d}T00:00:00Z`;
  const diag = (
    d: string,
    kind: string,
    disp: string,
    body = "reason",
  ): CommentFact => ({
    createdAt: at(d),
    trusted: true,
    body: `**diagnosis** — ${kind} — ${disp} — ${body}`,
  });
  const presented = (
    d: string,
    kind = "ceremony-ratio" as const,
  ): CommentFact => ({
    createdAt: at(d),
    trusted: true,
    body: `**fleet-health** — ${kind}\n\n${suspicionMarker(kind)}`,
  });

  it("is new when nothing was ever said on the epic", () => {
    expect(deriveLifecycle("ceremony-ratio", [], NOW, 14).state).toBe("new");
  });

  it("recognises the sensor's OWN comment as a presentation, so it does not re-comment", () => {
    const s = ceremonyRatioSignal(
      {
        epic: "ENG-1",
        progress: {
          mergedProductPrs: [],
          criteriaClosed: [],
          accepted: false,
          weighted: 0,
        },
        ceremony: {
          roundsBeyondFree: [],
          followupsMinted: ["ENG-9"],
          sdlcIssuesOpened: [],
          weighted: 6,
        },
      },
      CFG,
    );
    const report = buildReport({
      ...units(),
      nowMs: NOW,
      depthByPr: new Map(),
      epicComments: new Map(),
      delivery: null,
      gaps: [],
      caveats: [],
    });
    const body = suspicionComment(
      {
        kind: "ceremony-ratio",
        epic: "ENG-1",
        signals: [s as NonNullable<typeof s>],
      },
      report,
    );
    expect(body.trimEnd().endsWith(suspicionMarker("ceremony-ratio"))).toBe(
      true,
    );
    expect(
      deriveLifecycle(
        "ceremony-ratio",
        [{ createdAt: at("12"), body, trusted: true }],
        NOW,
        14,
      ).state,
    ).toBe("awaiting-diagnosis");
  });

  it("stays awaiting-diagnosis until someone answers, however long that takes", () => {
    expect(
      deriveLifecycle("ceremony-ratio", [presented("01")], NOW, 14).state,
    ).toBe("awaiting-diagnosis");
  });

  it("treats established as diagnosed, not as an all-clear", () => {
    const l = deriveLifecycle(
      "ceremony-ratio",
      [presented("01"), diag("02", "ceremony-ratio", "established")],
      NOW,
      14,
    );
    expect(l.state).toBe("diagnosed");
    expect(l.disposition).toBe("established");
  });

  it("cools down after any closing disposition, then re-presents when the cooldown ends", () => {
    const cleared = [
      presented("01"),
      diag("10", "ceremony-ratio", "false-positive"),
    ];
    const cooling = deriveLifecycle("ceremony-ratio", cleared, NOW, 14);
    expect(cooling.state).toBe("cooling-down");
    expect(cooling.cooldownUntil).toBe("2026-09-24T00:00:00.000Z");
    expect(
      deriveLifecycle(
        "ceremony-ratio",
        cleared,
        Date.parse("2026-09-24T00:00:00Z"),
        14,
      ).state,
    ).toBe("new");
    expect(
      deriveLifecycle(
        "ceremony-ratio",
        [diag("10", "ceremony-ratio", "resolved")],
        NOW,
        14,
      ).state,
    ).toBe("cooling-down");
  });

  it("does not let one kind's diagnosis silence another kind", () => {
    const comments = [
      presented("01"),
      diag("02", "followup-depth", "false-positive"),
    ];
    expect(deriveLifecycle("ceremony-ratio", comments, NOW, 14).state).toBe(
      "awaiting-diagnosis",
    );
    expect(deriveLifecycle("followup-depth", comments, NOW, 14).state).toBe(
      "cooling-down",
    );
  });

  it("takes a newer presentation over an older diagnosis", () => {
    const comments = [
      diag("01", "ceremony-ratio", "false-positive"),
      presented("14"),
    ];
    expect(deriveLifecycle("ceremony-ratio", comments, NOW, 14).state).toBe(
      "awaiting-diagnosis",
    );
  });

  it("reads a diagnosis the way a person types it", () => {
    const c = (body: string): CommentFact => ({
      createdAt: at("05"),
      body,
      trusted: true,
    });
    expect(
      deriveLifecycle(
        "ceremony-ratio",
        [
          c(
            "**Diagnosis** — ceremony-ratio — False-Positive — terminal-week spike",
          ),
        ],
        NOW,
        14,
      ).disposition,
    ).toBe("false-positive");
    expect(
      deriveLifecycle(
        "ceremony-ratio",
        [c("diagnosis: ceremony-ratio - resolved - fixed")],
        NOW,
        14,
      ).disposition,
    ).toBe("resolved");
    expect(
      deriveLifecycle(
        "ceremony-ratio",
        [c("I looked at it and it is fine")],
        NOW,
        14,
      ).state,
    ).toBe("new");
  });

  it("presents per epic: quiet where already diagnosed, presentable where not", () => {
    const depthPr = pr(4738, { issueRefs: ["ENG-1"] });
    const report = buildReport({
      ...units({
        prs: [depthPr],
        issues: new Map([
          [
            "ENG-1",
            issue("ENG-1", {
              ancestors: [
                { id: "E-A", labels: ["epic"] },
                { id: "E-B", labels: ["epic"] },
              ],
            }),
          ],
        ]),
      }),
      nowMs: NOW,
      depthByPr: new Map([
        [
          4738,
          {
            depth: 2,
            chain: [4738, 4666, 4645],
            truncated: false,
            originless: false,
          },
        ],
      ]),
      epicComments: new Map(),
      delivery: null,
      gaps: [],
      caveats: [],
    });
    // The fixture attributes to E-A only (nearest epic), so build a two-epic signal by hand.
    const sig = report.signals.find((s) => s.kind === "followup-depth");
    expect(sig).toBeDefined();
    if (sig?.scope.type === "pr") sig.scope.epics = ["E-A", "E-B"];
    const quiet = new Map([
      ["E-A", [diag("12", "followup-depth", "false-positive")]],
    ]);
    expect(presentable(report, quiet, NOW, 14).map((t) => t.epic)).toEqual([
      "E-B",
    ]);
  });
});

describe("a multi-epic signal never reads quiet while one of its epics is live", () => {
  const NOW = Date.parse("2026-09-15T00:00:00Z");

  it("takes the most active lifecycle across its epics, so the drive brief and active list keep it", () => {
    const report = buildReport({
      ...units({
        prs: [pr(4738, { issueRefs: ["ENG-1", "ENG-2"] })],
        issues: new Map([
          [
            "ENG-1",
            issue("ENG-1", { ancestors: [{ id: "E-A", labels: ["epic"] }] }),
          ],
          [
            "ENG-2",
            issue("ENG-2", { ancestors: [{ id: "E-B", labels: ["epic"] }] }),
          ],
        ]),
      }),
      nowMs: NOW,
      depthByPr: new Map([
        [
          4738,
          {
            depth: 2,
            chain: [4738, 4666, 4645],
            truncated: false,
            originless: false,
          },
        ],
      ]),
      // E-A (sorts first) is cooling down after a closing diagnosis; E-B was
      // presented and still awaits its owner's diagnosis.
      epicComments: new Map<string, CommentFact[]>([
        [
          "E-A",
          [
            {
              createdAt: "2026-09-12T00:00:00Z",
              trusted: true,
              body: "**diagnosis** — followup-depth — false-positive — reason",
            },
          ],
        ],
        [
          "E-B",
          [
            {
              createdAt: "2026-09-10T00:00:00Z",
              trusted: true,
              body: `**fleet-health** — followup-depth\n\n${suspicionMarker("followup-depth")}`,
            },
          ],
        ],
      ]),
      delivery: null,
      gaps: [],
      caveats: [],
    });
    const sig = report.signals.find((x) => x.kind === "followup-depth");
    expect(sig?.lifecycle?.state).toBe("awaiting-diagnosis");
    expect(activeSignals(report).map((x) => x.kind)).toContain(
      "followup-depth",
    );
  });
});

describe("presenting a suspicion on an epic", () => {
  const NOW = Date.parse("2026-09-15T00:00:00Z");

  function depthReport(count: number) {
    const prs = Array.from({ length: count }, (_, i) =>
      pr(9000 + i, { issueRefs: ["ENG-1"] }),
    );
    return buildReport({
      ...units({
        prs,
        issues: new Map([
          [
            "ENG-1",
            issue("ENG-1", { ancestors: [{ id: "E-A", labels: ["epic"] }] }),
          ],
        ]),
      }),
      nowMs: NOW,
      depthByPr: new Map(
        prs.map((p, i) => [
          p.number,
          {
            depth: 2 + (i % 3),
            chain: [p.number, 1, 2],
            truncated: false,
            originless: false,
          },
        ]),
      ),
      epicComments: new Map(),
      delivery: null,
      gaps: [],
      caveats: [],
    });
  }

  it("makes ONE presentation per (kind, epic), however many PRs raised on it", () => {
    const report = depthReport(12);
    const groups = presentable(report, new Map(), NOW, 14);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.signals).toHaveLength(12);
  });

  it("caps the comment, ranks the worst first, and says how many more there are", () => {
    const report = depthReport(12);
    const g = presentable(report, new Map(), NOW, 14)[0] as NonNullable<
      ReturnType<typeof presentable>[number]
    >;
    const body = suspicionComment(g, report);
    expect(body.match(/^\*\*PR #/gm)).toHaveLength(5);
    expect(body).toMatch(/and 7 more/);
    // twelve PRs at depths 2, 3, 4 (four each): the five shown are the deepest
    expect(body).toMatch(/depth 4/);
    expect(body).not.toMatch(/depth 2/);
    expect(body.trimEnd().endsWith(suspicionMarker("followup-depth"))).toBe(
      true,
    );
  });

  it("is silent for an epic that has already been diagnosed, and speaks again once the cooldown ends", () => {
    const report = depthReport(3);
    const diag = {
      createdAt: "2026-09-10T00:00:00Z",
      trusted: true,
      body: "**diagnosis** — followup-depth — early — watching",
    };
    expect(presentable(report, new Map([["E-A", [diag]]]), NOW, 14)).toEqual(
      [],
    );
    expect(
      presentable(
        report,
        new Map([["E-A", [diag]]]),
        Date.parse("2026-09-25T00:00:00Z"),
        14,
      ),
    ).toHaveLength(1);
  });
});

describe("the report", () => {
  it("never lists a PR-level advisory on an epic, and keeps them for the drive brief", () => {
    const carousel = reviewCarouselSignal(
      pr(77, {
        rounds: Array.from({ length: 30 }, () => IN),
        postReviewShare: 0.9,
        postReviewAdditions: 9,
        openingAdditions: 1,
      }),
      ["ENG-1"],
      CFG,
    );
    expect(prWarnings(carousel === null ? [] : [carousel], 77)[0]).toMatch(
      /^review-carousel:/,
    );
    expect(prWarnings(carousel === null ? [] : [carousel], 78)).toEqual([]);
  });

  it("states its partiality and its standing caveats when rendered", () => {
    const text = renderReport(
      buildReport({
        ...units(),
        nowMs: UNTIL,
        depthByPr: new Map(),
        epicComments: new Map(),
        delivery: null,
        gaps: ["3 PR(s) could not be sampled"],
        caveats: ["ceremony is a lower bound"],
      }),
    );
    expect(text).toMatch(/PARTIAL/);
    expect(text).toMatch(/3 PR\(s\) could not be sampled/);
    expect(text).toMatch(/lower bound/);
    expect(text).not.toMatch(/NaN|Infinity/);
  });
});

// ── The composition ─────────────────────────────────────────────────────────

function listing(number: number, over: Partial<PrListing> = {}): PrListing {
  return {
    number,
    title: `pr ${number}`,
    body: "",
    state: "MERGED",
    createdAt: IN,
    mergedAt: IN,
    closedAt: IN,
    updatedAt: IN,
    ...over,
  };
}

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    cfg: CFG,
    nowMs: () => UNTIL + DAY,
    budget: async () => ({
      remaining: 5000,
      resetAt: "2026-09-15T01:00:00.000Z",
    }),
    listCandidates: async () => ({ prs: [], capped: false }),
    reviewedHeads: async () => 0,
    samplePr: async () => {
      throw new Error("should not be sampled");
    },
    prFiles: async () => [],
    prBody: async () => "",
    classifier: {
      classify: () => ({
        productPr: true,
        deliveryLines: 0,
        totalLines: 10,
        unclaimedSkillLines: 0,
      }),
    },
    classifierError: null,
    tracker: null,
    trackerError: "test: no tracker",
    fetchIssues: async () => new Map(),
    fetchWindowIssues: async () => ({
      followups: [],
      sdlcIssues: [],
      completed: [],
    }),
    fetchEpicActivity: async () => [],
    fetchAcceptedEpics: async () => new Set(),
    fetchEpicComments: async () => ({ uuid: "u", comments: [] }),
    note: () => undefined,
    ...over,
  };
}

const OPTS = { until: "2026-09-15", days: 14, limit: 100, concurrency: 2 };

describe("runFleetHealth", () => {
  it("refuses to start when the shared GitHub budget would not survive it", async () => {
    const d = deps({
      budget: async () => ({
        remaining: MIN_GRAPHQL_BUDGET - 1,
        resetAt: "later",
      }),
    });
    await expect(runFleetHealth(OPTS, d)).rejects.toBeInstanceOf(BudgetError);
  });

  it("does not sample a PR with no more reviewed heads than free_rounds", async () => {
    const r = await runFleetHealth(
      OPTS,
      deps({
        reviewedHeads: async () => CFG.ceremony.freeRounds,
        listCandidates: async () => ({ prs: [listing(1)], capped: false }),
      }),
    );
    expect(r.report.counts.prs).toBe(1);
  });

  it("samples a PR listed with more, and one whose reviews the listing did not carry", async () => {
    const sampled: number[] = [];
    await runFleetHealth(
      OPTS,
      deps({
        reviewedHeads: async (n) =>
          n === 2 ? CFG.ceremony.freeRounds + 1 : null,
        listCandidates: async () => ({
          prs: [listing(2), listing(3)],
          capped: false,
        }),
        samplePr: async (n) => {
          sampled.push(n);
          throw new Error("unreadable");
        },
      }),
    );
    expect(sampled.sort()).toEqual([2, 3]);
  });

  it("reports unsampled PRs as a gap and stops trying after a run of failures", async () => {
    let calls = 0;
    const prs = Array.from({ length: 30 }, (_, i) => listing(100 + i));
    const r = await runFleetHealth(
      { ...OPTS, concurrency: 1 },
      deps({
        reviewedHeads: async () => 9,
        listCandidates: async () => ({ prs, capped: false }),
        samplePr: async () => {
          calls++;
          throw new Error("rate limited");
        },
      }),
    );
    expect(calls).toBeLessThan(30);
    expect(r.report.gaps.join("\n")).toMatch(/could not be sampled/);
  });

  it("names the missing epic attribution as a gap when Linear is unreachable", async () => {
    const r = await runFleetHealth(OPTS, deps());
    expect(r.report.gaps.join("\n")).toMatch(
      /issue tracker could not be reached/,
    );
  });

  it("names an unavailable catalog as a gap rather than counting nothing as progress silently", async () => {
    const r = await runFleetHealth(
      OPTS,
      deps({
        classifier: null,
        classifierError: "boom",
        listCandidates: async () => ({ prs: [listing(4)], capped: false }),
      }),
    );
    expect(r.report.gaps.join("\n")).toMatch(
      /could not be classified by change area \(boom\)/,
    );
  });

  it("reads the #4738 chain end to end from listings and the tracker", async () => {
    const body: Record<number, string> = {
      4738: "| Closes ENG-7905 | x |",
      4666: "Closes ENG-7861\nCloses ENG-7850",
      4645: "References: ENG-7845",
    };
    const fu = (id: string, origin: number) =>
      issue(id, {
        labels: ["follow-up"],
        description: `from PR example-org/example-repo#${origin}`,
      });
    const known = new Map<string, IssueFact>([
      ["ENG-7905", fu("ENG-7905", 4666)],
      ["ENG-7861", fu("ENG-7861", 4645)],
      ["ENG-7850", issue("ENG-7850")],
      ["ENG-7845", issue("ENG-7845")],
    ]);
    const r = await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({
          prs: [
            listing(4738, {
              state: "CLOSED",
              mergedAt: null,
              body: body[4738] as string,
            }),
          ],
          capped: false,
        }),
        prBody: async (n) => body[n] ?? null,
        tracker: STUB_TRACKER,
        trackerError: null,
        fetchIssues: async (ids) =>
          new Map(
            ids.flatMap((id) =>
              known.has(id) ? [[id, known.get(id) as IssueFact] as const] : [],
            ),
          ),
      }),
    );
    const depth = r.report.signals.find((s) => s.kind === "followup-depth");
    expect(depth?.severity).toBe("elevated");
    expect(depth?.value).toBe(2);
    expect(depth?.evidence[0]).toMatch(/#4738 ← #4666 ← #4645/);
  });
});

// ── Review-driven additions ────────────────────────────────────────────────

describe("attribution to an epic named directly", () => {
  it("counts a trailer that names the epic itself toward that epic (PR #5032 →)", () => {
    const epic = issue("ENG-7488", { labels: ["epic"], ancestors: [] });
    expect(epicOf(epic)).toBe("ENG-7488");
    const plan = pr(5032, {
      issueRefs: ["ENG-7488"],
      rounds: Array.from({ length: 12 }, () => IN),
    });
    expect(epicsOfPr(plan, new Map([["ENG-7488", epic]]))).toEqual([
      "ENG-7488",
    ]);
    const u = computeEpicUnits(
      units({ prs: [plan], issues: new Map([["ENG-7488", epic]]) }),
    );
    expect(u.get("ENG-7488")?.ceremony.roundsBeyondFree[0]?.rounds).toBe(
      12 - CFG.ceremony.freeRounds,
    );
  });
});

describe("follow-up walk cost and completeness", () => {
  const followup = (id: string, origin: number) =>
    issue(id, {
      labels: ["follow-up"],
      description: `Review deferral from PR example-org/example-repo#${origin} round 9.`,
    });

  it("walks a shared origin once however many follow-ups point at it, and shares the work across walks", async () => {
    // three follow-ups per PR, all raised on the same origin, six levels deep
    const m = new Map<number, IssueFact[]>();
    for (let n = 1000; n < 1008; n++) {
      m.set(n, [
        followup(`A${n}`, n + 1),
        followup(`B${n}`, n + 1),
        followup(`C${n}`, n + 1),
      ]);
    }
    m.set(1008, []);
    let reads = 0;
    const memo = new Map<
      string,
      Promise<import("../scripts/lib/fleet-health.ts").DepthResult>
    >();
    const d = depsOf(m, () => reads++);
    await followupDepth(1000, d, 6, memo);
    const first = reads;
    expect(first).toBeLessThanOrEqual(8);
    // the same PR asked again with the SAME budget is free
    await followupDepth(1000, d, 6, memo);
    expect(reads).toBe(first);
  });

  it("does not hand a truncated depth to a later chain that reaches the same origin with more hops left", async () => {
    // 101 → 102 → … → 106 → 107 (one follow-up per link); 109 → 105 directly.
    // Walking 101 first reaches 105 with a small budget; 109 reaches it with more.
    const m = new Map<number, IssueFact[]>([
      [101, [followup("F1", 102)]],
      [102, [followup("F2", 103)]],
      [103, [followup("F3", 104)]],
      [104, [followup("F4", 105)]],
      [105, [followup("F5", 106)]],
      [106, [followup("F6", 107)]],
      [107, []],
      [109, [followup("F9", 105)]],
    ]);
    const d = depsOf(m);
    const memo = new Map<
      string,
      Promise<import("../scripts/lib/fleet-health.ts").DepthResult>
    >();
    const short = await followupDepth(101, d, 3, memo);
    expect(short.truncated).toBe(true);
    const deep = await followupDepth(109, d, 3, memo);
    // 109 ← 105 ← 106 ← 107: depth 3 within a budget of 3, not the depth the
    // truncated walk through 101 left cached for 105
    expect(deep.depth).toBe(3);
    expect(deep.truncated).toBe(false);
  });

  it("marks a walk truncated when a PR names an issue Linear cannot resolve", async () => {
    const r = await followupDepth(
      1,
      { issuesOfPr: async () => ({ issues: [], complete: false }) },
      6,
    );
    expect(r.truncated).toBe(true);
  });
});

describe("reading a diagnosis the way people write it", () => {
  const NOW = Date.parse("2026-09-15T00:00:00Z");
  const c = (
    body: string,
    createdAt = "2026-09-10T00:00:00Z",
  ): CommentFact => ({ body, createdAt, trusted: true });

  it("accepts a list bullet and a kind spelled with spaces", () => {
    expect(
      deriveLifecycle(
        "ceremony-ratio",
        [c("- **diagnosis** — ceremony ratio — false-positive — spike")],
        NOW,
        14,
      ).state,
    ).toBe("cooling-down");
  });

  it("does not read a diagnosis that merely quotes the sensor marker as a fresh presentation", () => {
    const quoted = c(
      `**diagnosis** — ceremony-ratio — false-positive — was:\n> ${suspicionMarker("ceremony-ratio")}\nbut fine`,
    );
    expect(deriveLifecycle("ceremony-ratio", [quoted], NOW, 14).state).toBe(
      "cooling-down",
    );
  });

  it("reads a kind spelled with spaces, and emphasis or a colon after the word", () => {
    for (const body of [
      "**diagnosis** — follow-up depth — false-positive — x",
      "**Diagnosis:** followup-depth — false-positive — x",
      "diagnosis: followup depth - false-positive - x",
    ]) {
      expect(deriveLifecycle("followup-depth", [c(body)], NOW, 14).state).toBe(
        "cooling-down",
      );
    }
  });

  it('counts a comment that BEGINS "diagnosis" but does not parse, and only that', () => {
    const bad = c("Diagnosis: this is fine, ignore");
    const unknownKind = c("**diagnosis** — nonsense-kind — resolved — x");
    expect(unparsedDiagnoses([bad, unknownKind, c("unrelated")])).toEqual([
      bad,
      unknownKind,
    ]);
    // conversation that merely MENTIONS the word is not a failed answer
    expect(unparsedDiagnoses([c("Thanks — diagnosis after standup")])).toEqual(
      [],
    );
    expect(
      unparsedDiagnoses([
        c("**diagnosis** — ceremony-ratio — resolved — fixed"),
      ]),
    ).toEqual([]);
  });

  it("does not read a prefix of a declared disposition as that disposition", () => {
    for (const disp of ["resolvedly", "earlybird", "establishedish"]) {
      const comment = c(`**diagnosis** — ceremony-ratio — ${disp} — x`);
      // Never read as a disposition (that would be `cooling-down`); a malformed
      // diagnosis naming this signal leaves it unanswerable instead.
      expect(deriveLifecycle("ceremony-ratio", [comment], NOW, 14).state).toBe(
        "unknown",
      );
      expect(unparsedDiagnoses([comment])).toEqual([comment]);
    }
  });

  it("requires a reason: a line that stops at the disposition does not parse", () => {
    for (const bare of [
      "**diagnosis** — ceremony-ratio — false-positive",
      "**diagnosis** — ceremony-ratio — false-positive —",
      "**diagnosis** — ceremony-ratio — false-positive **",
    ]) {
      const comment = c(bare);
      // Never read as a disposition (that would be `cooling-down`); a malformed
      // diagnosis naming this signal leaves it unanswerable instead.
      expect(deriveLifecycle("ceremony-ratio", [comment], NOW, 14).state).toBe(
        "unknown",
      );
      expect(unparsedDiagnoses([comment])).toEqual([comment]);
    }
  });

  it("ignores a diagnosis or presentation from an untrusted author", () => {
    const forged: CommentFact = {
      ...c("**diagnosis** — ceremony-ratio — false-positive — nope"),
      trusted: false,
    };
    const forgedMarker: CommentFact = {
      ...c(`x\n\n${suspicionMarker("ceremony-ratio")}`),
      trusted: false,
    };
    expect(
      deriveLifecycle("ceremony-ratio", [forged, forgedMarker], NOW, 14).state,
    ).toBe("new");
    // and an untrusted unparseable one is not an answer the sensor must respect
    expect(
      unparsedDiagnoses([{ ...c("Diagnosis: fine"), trusted: false }]),
    ).toEqual([]);
  });

  it("caps the first line it parses, so a hostile comment cannot make the parse slow", () => {
    const hostile = c(`diagnosis - a${"-".repeat(20000)}x`);
    const t = performance.now();
    unparsedDiagnoses([hostile]);
    expect(performance.now() - t).toBeLessThan(200);
  });

  it("shows the lifecycle of an epic whose comments were not read as unknown, never as new", () => {
    const prs = [
      pr(1, {
        issueRefs: ["ENG-2"],
        rounds: Array.from({ length: 12 }, () => IN),
      }),
    ];
    const report = buildReport({
      ...units({ prs, issues: new Map([["ENG-2", issue("ENG-2")]]) }),
      nowMs: NOW,
      depthByPr: new Map(),
      epicComments: new Map(),
      unknownEpics: new Set(["ENG-1"]),
      delivery: null,
      gaps: [],
      caveats: [],
    });
    const s = report.signals.find((x) => x.kind === "ceremony-ratio");
    expect(s?.lifecycle?.state).toBe("unknown");
    expect(presentable(report, new Map(), NOW, 14, new Set(["ENG-1"]))).toEqual(
      [],
    );
  });
});

describe("the drive-brief warning during a cooldown", () => {
  it("is silent for a signal whose suspicion a diagnosis closed, and speaks for the rest", () => {
    const base = {
      kind: "followup-depth" as const,
      scope: { type: "pr" as const, pr: 9, epics: ["E"] },
      severity: "elevated" as const,
      headline: "depth 2",
    };
    expect(prWarnings([{ ...base, state: "cooling-down" }], 9)).toEqual([]);
    expect(
      prWarnings([{ ...base, state: "awaiting-diagnosis" }], 9),
    ).toHaveLength(1);
    expect(prWarnings([{ ...base, state: null }], 9)).toHaveLength(1);
  });
});

describe("unattributed ceremony", () => {
  it("counts rounds on PRs and follow-ups that name no epic, so no numerator is silently narrower", () => {
    const rounds = Array.from(
      { length: CFG.ceremony.freeRounds + 2 },
      () => IN,
    );
    const n = unattributedCeremony(
      units({
        prs: [pr(1, { rounds })],
        followups: [issue("ENG-90", { labels: ["follow-up"], ancestors: [] })],
      }),
    );
    expect(n).toBe(3);
  });
});

// ── Posting ────────────────────────────────────────────────────────────────

describe("postSuspicions", () => {
  const NOW = Date.parse("2026-09-15T00:00:00Z");
  const reportFor = (epics: string[], gaps: string[] = []) =>
    buildReport({
      ...units({
        prs: epics.map((_e, i) =>
          pr(10 + i, {
            issueRefs: [`ENG-${100 + i}`],
            rounds: Array.from(
              {
                length:
                  CFG.ceremony.freeRounds +
                  CFG.signals.ceremonyRatio.minCeremony,
              },
              () => IN,
            ),
          }),
        ),
        issues: new Map(
          epics.map((e, i) => [
            `ENG-${100 + i}`,
            issue(`ENG-${100 + i}`, {
              ancestors: [{ id: e, labels: ["epic"] }],
            }),
          ]),
        ),
      }),
      nowMs: NOW,
      depthByPr: new Map(),
      epicComments: new Map(),
      delivery: null,
      gaps,
      caveats: [],
    });

  function fakes(
    perEpic: Record<string, CommentFact[]> = {},
    failOn: string[] = [],
  ) {
    const posted: Array<{ uuid: string; body: string }> = [];
    const deps: PostDeps = {
      fetchEpicComments: async (e) => ({
        uuid: `uuid-${e}`,
        comments: perEpic[e] ?? [],
      }),
      postComment: async (uuid, body) => {
        if (failOn.includes(uuid)) throw new Error("Linear 500");
        posted.push({ uuid, body });
      },
    };
    return { deps, posted };
  }

  it("comments once per (kind, epic) and each comment ends with the marker the lifecycle keys on", async () => {
    const report = reportFor(["E-A", "E-B"]);
    const { deps, posted } = fakes();
    const out = await postSuspicions(
      report,
      new Map(),
      new Set(),
      CFG,
      NOW,
      deps,
    );
    expect(out.posted.sort()).toEqual([
      "ceremony-ratio→E-A",
      "ceremony-ratio→E-B",
    ]);
    expect(posted).toHaveLength(2);
    for (const p of posted)
      expect(p.body.trimEnd().endsWith(suspicionMarker("ceremony-ratio"))).toBe(
        true,
      );
  });

  it("REFUSES on a partial report and posts nothing", async () => {
    const report = reportFor(
      ["E-A"],
      ["the change-area catalog is unavailable"],
    );
    const { deps, posted } = fakes();
    const out = await postSuspicions(
      report,
      new Map(),
      new Set(),
      CFG,
      NOW,
      deps,
    );
    expect(out.refused).toMatch(/partial/);
    expect(posted).toEqual([]);
  });

  it("does not comment again when the epic already carries the sensor comment (re-read just before posting)", async () => {
    const report = reportFor(["E-A"]);
    const already: CommentFact = {
      createdAt: "2026-09-14T00:00:00Z",
      trusted: true,
      body: `x\n\n${suspicionMarker("ceremony-ratio")}`,
    };
    // the report was built without seeing it — a concurrent run landed it since
    const { deps, posted } = fakes({ "E-A": [already] });
    const out = await postSuspicions(
      report,
      new Map(),
      new Set(),
      CFG,
      NOW,
      deps,
    );
    expect(posted).toEqual([]);
    expect(out.skipped[0]).toMatch(/awaiting-diagnosis/);
  });

  it("never posts on an epic whose comments could not be read", async () => {
    const report = reportFor(["E-A", "E-B"]);
    const { deps, posted } = fakes();
    const out = await postSuspicions(
      report,
      new Map(),
      new Set(["E-A"]),
      CFG,
      NOW,
      deps,
    );
    expect(out.posted).toEqual(["ceremony-ratio→E-B"]);
    expect(posted).toHaveLength(1);
  });

  it("carries on after one failed post and returns every failure", async () => {
    const report = reportFor(["E-A", "E-B", "E-C"]);
    const { deps, posted } = fakes({}, ["uuid-E-B"]);
    const out = await postSuspicions(
      report,
      new Map(),
      new Set(),
      CFG,
      NOW,
      deps,
    );
    expect(out.failed).toEqual([
      { target: "ceremony-ratio→E-B", error: "Linear 500" },
    ]);
    expect(out.posted.sort()).toEqual([
      "ceremony-ratio→E-A",
      "ceremony-ratio→E-C",
    ]);
    expect(posted).toHaveLength(2);
  });
});

describe("the no-re-comment guarantee, end to end", () => {
  it("reads the epic comments through runFleetHealth so a presented signal is not presented again", async () => {
    const fu = (id: string, origin: number) =>
      issue(id, {
        labels: ["follow-up"],
        description: `from PR example-org/example-repo#${origin}`,
      });
    const known = new Map<string, IssueFact>([
      [
        "ENG-7905",
        {
          ...fu("ENG-7905", 4666),
          ancestors: [{ id: "ENG-7488", labels: ["epic"] }],
        },
      ],
      ["ENG-7861", fu("ENG-7861", 4645)],
    ]);
    const body: Record<number, string> = {
      4738: "Closes ENG-7905",
      4666: "Closes ENG-7861",
      4645: "References: ENG-1",
    };
    const mk = (comments: CommentFact[]) =>
      deps({
        listCandidates: async () => ({
          prs: [
            listing(4738, {
              state: "CLOSED",
              mergedAt: null,
              body: body[4738] as string,
            }),
          ],
          capped: false,
        }),
        reviewedHeads: async () => 1,
        prBody: async (n) => body[n] ?? null,
        tracker: STUB_TRACKER,
        trackerError: null,
        fetchIssues: async (ids) =>
          new Map(
            ids.flatMap((id) =>
              known.has(id) ? [[id, known.get(id) as IssueFact] as const] : [],
            ),
          ),
        fetchEpicComments: async () => ({ uuid: "u", comments }),
      });
    const fresh = await runFleetHealth(OPTS, mk([]));
    expect(
      presentable(
        fresh.report,
        new Map([...fresh.epicComments].map(([e, c]) => [e, c.comments])),
        UNTIL,
        CFG.lifecycle.cooldownDays,
        fresh.unknownEpics,
      ),
    ).toHaveLength(1);
    const presentedComment: CommentFact = {
      createdAt: "2026-09-14T00:00:00Z",
      trusted: true,
      body: `x\n\n${suspicionMarker("followup-depth")}`,
    };
    const again = await runFleetHealth(OPTS, mk([presentedComment]));
    expect(
      again.report.signals.find((s) => s.kind === "followup-depth")?.lifecycle
        ?.state,
    ).toBe("awaiting-diagnosis");
    expect(
      presentable(
        again.report,
        new Map([...again.epicComments].map(([e, c]) => [e, c.comments])),
        UNTIL,
        CFG.lifecycle.cooldownDays,
        again.unknownEpics,
      ),
    ).toEqual([]);
  });

  it("marks an epic unknown, and gaps the report, when its comments cannot be read", async () => {
    const fu = issue("ENG-7905", {
      labels: ["follow-up"],
      description: "from PR example-org/example-repo#4666",
      ancestors: [{ id: "ENG-7488", labels: ["epic"] }],
    });
    const other = issue("ENG-7861", {
      labels: ["follow-up"],
      description: "from PR example-org/example-repo#4645",
    });
    const r = await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({
          prs: [
            listing(4738, {
              state: "CLOSED",
              mergedAt: null,
              body: "Closes ENG-7905",
            }),
          ],
          capped: false,
        }),
        reviewedHeads: async () => 1,
        prBody: async (n) =>
          n === 4666
            ? "Closes ENG-7861"
            : n === 4645
              ? "References: ENG-1"
              : null,
        tracker: STUB_TRACKER,
        trackerError: null,
        fetchIssues: async (ids) => {
          const m = new Map<string, IssueFact>();
          if (ids.includes("ENG-7905")) m.set("ENG-7905", fu);
          if (ids.includes("ENG-7861")) m.set("ENG-7861", other);
          return m;
        },
        fetchEpicComments: async () => {
          throw new Error("Linear 502");
        },
      }),
    );
    expect(r.unknownEpics.has("ENG-7488")).toBe(true);
    expect(r.report.gaps.join("\n")).toMatch(
      /comments on ENG-7488 could not be read/,
    );
    expect(
      r.report.signals.find((s) => s.kind === "followup-depth")?.lifecycle
        ?.state,
    ).toBe("unknown");
  });

  it("reports a truncated follow-up walk as a gap instead of a quiet depth 0", async () => {
    const fu = issue("ENG-7905", {
      labels: ["follow-up"],
      description: "from PR example-org/example-repo#4666",
      ancestors: [{ id: "ENG-7488", labels: ["epic"] }],
    });
    const r = await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({
          prs: [
            listing(4738, {
              state: "CLOSED",
              mergedAt: null,
              body: "Closes ENG-7905",
            }),
          ],
          capped: false,
        }),
        reviewedHeads: async () => 1,
        prBody: async () => null,
        tracker: STUB_TRACKER,
        trackerError: null,
        fetchIssues: async (ids) =>
          new Map(
            ids.flatMap((id) => (id === "ENG-7905" ? [[id, fu] as const] : [])),
          ),
      }),
    );
    expect(r.report.gaps.join("\n")).toMatch(
      /follow-up chain\(s\) could not be walked/,
    );
  });

  it("requests an issue ID Linear cannot resolve once, however many walks meet it", async () => {
    const fu1 = issue("ENG-7905", {
      labels: ["follow-up"],
      description: "from PR example-org/example-repo#4666",
      ancestors: [{ id: "ENG-7488", labels: ["epic"] }],
    });
    const fu2 = issue("ENG-7906", {
      labels: ["follow-up"],
      description: "from PR example-org/example-repo#4667",
      ancestors: [{ id: "ENG-7488", labels: ["epic"] }],
    });
    const requested: string[] = [];
    await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({
          prs: [
            listing(4738, {
              state: "CLOSED",
              mergedAt: null,
              body: "Closes ENG-7905",
            }),
            listing(4739, {
              state: "CLOSED",
              mergedAt: null,
              body: "Closes ENG-7906",
            }),
          ],
          capped: false,
        }),
        reviewedHeads: async () => 1,
        // Two different origin PRs whose bodies name the same dead issue.
        prBody: async (n) =>
          n === 4666 || n === 4667 ? "Closes ENG-9999" : null,
        tracker: STUB_TRACKER,
        trackerError: null,
        fetchIssues: async (ids) => {
          requested.push(...ids);
          const m = new Map<string, IssueFact>();
          if (ids.includes("ENG-7905")) m.set("ENG-7905", fu1);
          if (ids.includes("ENG-7906")) m.set("ENG-7906", fu2);
          return m;
        },
      }),
    );
    expect(requested.filter((id) => id === "ENG-9999")).toHaveLength(1);
  });

  it("trips the failure breaker on a run of failures even when concurrent successes interleave", async () => {
    let calls = 0;
    const prs = Array.from({ length: 40 }, (_, i) => listing(200 + i));
    const r = await runFleetHealth(
      { ...OPTS, concurrency: 1 },
      deps({
        reviewedHeads: async () => 9,
        listCandidates: async () => ({ prs, capped: false }),
        samplePr: async () => {
          calls++;
          throw new Error("GraphQL: rate limited");
        },
      }),
    );
    expect(calls).toBe(5);
    expect(r.report.gaps.join("\n")).toMatch(
      /first failure: GraphQL: rate limited/,
    );
    expect(r.report.gaps.join("\n")).toMatch(
      /stopped after 5 failures in a row/,
    );
  });

  it("stops dispatching samples once the collector deadline aborts", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const r = await runFleetHealth(
      OPTS,
      deps({
        signal: ac.signal,
        reviewedHeads: async () => 9,
        listCandidates: async () => ({
          prs: [listing(300), listing(301)],
          capped: false,
        }),
        samplePr: async () => {
          calls++;
          throw new Error("unreachable");
        },
      }),
    );
    expect(calls).toBe(0);
    expect(r.report.gaps.join("\n")).toMatch(/collector deadline passed/);
  });
});

describe("review-round fixes: windows in the past, unparsed answers, epics as ceremony", () => {
  const NOW = Date.parse("2026-09-15T00:00:00Z");

  it("--post refuses on a window that ended in the past, whatever else is complete", async () => {
    const old = buildReport({
      ...units(),
      window: { sinceMs: NOW - 60 * DAY, untilMs: NOW - 46 * DAY },
      nowMs: NOW,
      depthByPr: new Map(),
      epicComments: new Map(),
      delivery: null,
      gaps: [],
      caveats: [],
    });
    const posted: string[] = [];
    const out = await postSuspicions(old, new Map(), new Set(), CFG, NOW, {
      fetchEpicComments: async () => ({ uuid: "u", comments: [] }),
      postComment: async (u) => void posted.push(u),
    });
    expect(out.refused).toMatch(/window ended in the past/);
    expect(posted).toEqual([]);
  });

  it("marks an epic that carries an unparsed diagnosis unknown, with a caveat and no gap", async () => {
    const fu = issue("ENG-7905", {
      labels: ["follow-up"],
      description: "from PR example-org/example-repo#4666",
      ancestors: [{ id: "ENG-7488", labels: ["epic"] }],
    });
    const other = issue("ENG-7861", {
      labels: ["follow-up"],
      description: "from PR example-org/example-repo#4645",
    });
    const r = await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({
          prs: [
            listing(4738, {
              state: "CLOSED",
              mergedAt: null,
              body: "Closes ENG-7905",
            }),
          ],
          capped: false,
        }),
        reviewedHeads: async () => 1,
        prBody: async (n) =>
          n === 4666
            ? "Closes ENG-7861"
            : n === 4645
              ? "References: ENG-1"
              : null,
        tracker: STUB_TRACKER,
        trackerError: null,
        fetchIssues: async (ids) => {
          const m = new Map<string, IssueFact>();
          if (ids.includes("ENG-7905")) m.set("ENG-7905", fu);
          if (ids.includes("ENG-7861")) m.set("ENG-7861", other);
          return m;
        },
        fetchEpicComments: async () => ({
          uuid: "u",
          comments: [
            {
              createdAt: "2026-09-10T00:00:00Z",
              trusted: true,
              body: "Diagnosis: this is fine",
            },
          ],
        }),
      }),
    );
    expect(r.report.gaps.join("\n")).not.toMatch(/diagnosis/);
    expect(r.report.caveats.join("\n")).toMatch(
      /begins "diagnosis" but does not parse.*ENG-7488/,
    );
    expect(
      r.report.signals.find((s) => s.kind === "followup-depth")?.lifecycle
        ?.state,
    ).toBe("unknown");
  });

  it("postSuspicions never comments on an epic whose fresh comments hold an unparsed diagnosis", async () => {
    const report = buildReport({
      ...units({
        prs: [
          pr(1, {
            issueRefs: ["ENG-2"],
            rounds: Array.from(
              { length: CFG.ceremony.freeRounds + 6 },
              () => IN,
            ),
          }),
        ],
        issues: new Map([
          [
            "ENG-2",
            issue("ENG-2", { ancestors: [{ id: "E-A", labels: ["epic"] }] }),
          ],
        ]),
      }),
      nowMs: NOW,
      depthByPr: new Map(),
      epicComments: new Map(),
      delivery: null,
      gaps: [],
      caveats: [],
    });
    const posted: string[] = [];
    const out = await postSuspicions(report, new Map(), new Set(), CFG, NOW, {
      fetchEpicComments: async () => ({
        uuid: "u",
        comments: [
          {
            createdAt: "2026-09-14T00:00:00Z",
            body: "diagnosis: fine",
            trusted: true,
          },
        ],
      }),
      postComment: async (u) => void posted.push(u),
    });
    expect(posted).toEqual([]);
    expect(out.skipped[0]).toMatch(/unparsed diagnosis/);
  });

  it("does not charge an epic a ceremony unit for being a delivery-system epic itself", () => {
    const epic = issue("ENG-8527", {
      labels: ["epic", "delivery-system"],
      ancestors: [],
    });
    const u = computeEpicUnits(units({ sdlcIssues: [epic] }));
    expect(u.get("ENG-8527")?.ceremony.sdlcIssuesOpened ?? []).toEqual([]);
  });

  it("flags a circular follow-up chain instead of quietly reporting a shorter one", async () => {
    const fu = (id: string, origin: number) =>
      issue(id, {
        labels: ["follow-up"],
        description: `from PR example-org/example-repo#${origin}`,
      });
    const loop = new Map<number, IssueFact[]>([
      [101, [fu("A", 102)]],
      [102, [fu("B", 101)]],
    ]);
    expect((await followupDepth(101, depsOf(loop), 6)).truncated).toBe(true);
  });

  it("keeps a PR that closed in the window, or is still open, without sampling it; drops one closed before", async () => {
    const keep = await runFleetHealth(
      OPTS,
      deps({
        reviewedHeads: async () => 1,
        listCandidates: async () => ({
          prs: [
            listing(11, { state: "CLOSED", mergedAt: null, closedAt: IN }),
            listing(12, { state: "OPEN", mergedAt: null, closedAt: null }),
            listing(13, {
              state: "CLOSED",
              createdAt: BEFORE,
              mergedAt: null,
              closedAt: BEFORE,
            }),
          ],
          capped: false,
        }),
      }),
    );
    // 11 (closed in window) and 12 (open) stay as basic facts; 13 (closed before it) does not
    expect(keep.report.counts.prs).toBe(2);
  });
});

describe("run-level completeness", () => {
  const tracker = STUB_TRACKER;
  const ROUND_FREE = CFG.ceremony.freeRounds + 1;
  const review = (oid: string, submittedAt: string) => ({
    oid,
    submittedAt,
    author: "example-review",
    isBot: true,
    initiating: true,
  });
  const sampleWith = (reviews: ReturnType<typeof review>[]) =>
    ({
      pr: 200,
      state: "MERGED",
      additions: 10,
      deletions: 0,
      changedFiles: 1,
      baseRefName: "develop",
      headRefOid: "h",
      createdAt: "2026-09-02T00:00:00Z",
      mergedAt: IN,
      mergeCommitOid: "m",
      title: "t",
      commits: [],
      reviews,
      threads: [],
    }) as unknown as Awaited<ReturnType<RunDeps["samplePr"]>>;

  it("names an issue a PR trailer cites that Linear cannot resolve as a gap", async () => {
    const r = await runFleetHealth(
      OPTS,
      deps({
        tracker,
        trackerError: null,
        listCandidates: async () => ({
          prs: [listing(300, { body: "Closes ENG-9001" })],
          capped: false,
        }),
        reviewedHeads: async () => 0,
        fetchIssues: async () => new Map(),
      }),
    );
    expect(r.report.gaps.join("\n")).toMatch(/ENG-9001/);
  });

  it("still walks a PR whose follow-up issue the initial batch did not resolve", async () => {
    const fu = issue("ENG-7905", {
      labels: ["follow-up"],
      description: "from PR example-org/example-repo#4666 round 9",
    });
    const bodies: number[] = [];
    let calls = 0;
    const r = await runFleetHealth(
      OPTS,
      deps({
        tracker,
        trackerError: null,
        listCandidates: async () => ({
          prs: [listing(4738, { body: "Closes ENG-7905" })],
          capped: false,
        }),
        reviewedHeads: async () => 0,
        // the first batch misses it; a later single read resolves it
        fetchIssues: async (ids) =>
          calls++ === 0
            ? new Map()
            : new Map(ids.includes("ENG-7905") ? [["ENG-7905", fu]] : []),
        prBody: async (n) => {
          bodies.push(n);
          return "";
        },
      }),
    );
    expect(bodies).toContain(4666);
    // recovered by the walk, so the final report must not call it unresolved
    expect(r.report.gaps.join("\n")).not.toMatch(/ENG-7905/);
  });

  it("starts nothing after the collector deadline and reports why", async () => {
    const r = await runFleetHealth(
      OPTS,
      deps({
        signal: AbortSignal.abort(),
        tracker,
        trackerError: null,
        listCandidates: async () => ({
          prs: [listing(301)],
          capped: false,
        }),
        reviewedHeads: async () => 9,
        fetchIssues: async () => {
          throw new Error("must not be called");
        },
      }),
    );
    const gaps = r.report.gaps.join("\n");
    expect(gaps).toMatch(/collector deadline passed/);
    expect(gaps).toMatch(/tracker side could not be read in full/);
  });

  it("cuts rounds at the window end and reports the churn share as not measured", async () => {
    const r = await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({
          prs: [listing(200)],
          capped: false,
        }),
        reviewedHeads: async () => ROUND_FREE + 5,
        samplePr: async () =>
          sampleWith([
            review("a", "2026-09-10T00:00:00Z"),
            review("b", "2026-09-20T00:00:00Z"),
          ]),
      }),
    );
    expect(r.report.caveats.join("\n")).toMatch(
      /after this window's end.*#200/,
    );
  });
});

describe("bounded reads must not read as complete", () => {
  const ROUND_FREE = CFG.ceremony.freeRounds + 1;
  const review = (oid: string, submittedAt: string) => ({
    oid,
    submittedAt,
    author: "example-review",
    isBot: true,
    initiating: true,
  });
  const sampleOf = (
    reviews: ReturnType<typeof review>[],
    commits: { oid: string; committedDate: string }[] = [],
  ) =>
    ({
      pr: 210,
      state: "MERGED",
      additions: 10,
      deletions: 0,
      changedFiles: 1,
      baseRefName: "develop",
      headRefOid: "h",
      createdAt: "2026-09-02T00:00:00Z",
      mergedAt: IN,
      mergeCommitOid: "m",
      title: "t",
      commits: commits.map((c) => ({
        ...c,
        additions: 5,
        deletions: 0,
        parents: 1,
      })),
      reviews,
      threads: [],
    }) as unknown as Awaited<ReturnType<RunDeps["samplePr"]>>;

  it("keeps an old open PR that was only updated in the window, on the sampled branch as on the low-head one", async () => {
    const OLD = "2026-06-01T00:00:00Z";
    const open = listing(701, {
      state: "OPEN",
      createdAt: OLD,
      mergedAt: null,
      closedAt: null,
      updatedAt: IN,
    });
    const r = await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({ prs: [open], capped: false }),
        reviewedHeads: async () => ROUND_FREE + 5,
        samplePr: async () => sampleOf([review("a", "2026-07-01T00:00:00Z")]),
      }),
    );
    expect(r.report.counts.prs).toBe(1);
  });

  it("starts no per-PR read of any kind once the collector deadline has passed", async () => {
    let headReads = 0;
    const r = await runFleetHealth(
      OPTS,
      deps({
        signal: AbortSignal.abort(),
        listCandidates: async () => ({
          prs: [listing(401), listing(402)],
          capped: false,
        }),
        reviewedHeads: async () => {
          headReads++;
          return 0;
        },
      }),
    );
    expect(headReads).toBe(0);
    expect(r.report.gaps.join("\n")).toMatch(/collector deadline passed/);
  });

  it("dispatches neither the budget read nor the listing when the deadline has already passed", async () => {
    const calls: string[] = [];
    const r = await runFleetHealth(
      OPTS,
      deps({
        signal: AbortSignal.abort(),
        budget: async () => {
          calls.push("budget");
          return null;
        },
        listCandidates: async () => {
          calls.push("list");
          return { prs: [], capped: false };
        },
      }),
    );
    expect(calls).toEqual([]);
    expect(r.report.gaps.join("\n")).toMatch(/collector deadline passed/);
  });

  it("dispatches no listing when the deadline fires while the budget read is pending", async () => {
    const ac = new AbortController();
    const calls: string[] = [];
    const r = await runFleetHealth(
      OPTS,
      deps({
        signal: ac.signal,
        budget: async () => {
          ac.abort();
          return { remaining: 5000, resetAt: "2026-09-15T01:00:00.000Z" };
        },
        listCandidates: async () => {
          calls.push("list");
          return { prs: [], capped: false };
        },
      }),
    );
    expect(calls).toEqual([]);
    expect(r.report.gaps.join("\n")).toMatch(/collector deadline passed/);
  });

  it("samples no PR when the deadline fires while its review-list read is pending", async () => {
    const ac = new AbortController();
    let sampled = 0;
    const r = await runFleetHealth(
      OPTS,
      deps({
        signal: ac.signal,
        listCandidates: async () => ({
          prs: [listing(601)],
          capped: false,
        }),
        reviewedHeads: async () => {
          ac.abort();
          return ROUND_FREE + 5;
        },
        samplePr: async () => {
          sampled++;
          throw new Error("must not be sampled");
        },
      }),
    );
    expect(sampled).toBe(0);
    expect(r.report.gaps.join("\n")).toMatch(/collector deadline passed/);
  });

  it("keeps no PR when the deadline fires while a review-list read is pending and the head count is at or below free_rounds", async () => {
    const ac = new AbortController();
    const r = await runFleetHealth(
      OPTS,
      deps({
        signal: ac.signal,
        listCandidates: async () => ({
          prs: [listing(602)],
          capped: false,
        }),
        reviewedHeads: async () => {
          ac.abort();
          return 0;
        },
      }),
    );
    expect(r.report.gaps.join("\n")).toMatch(/collector deadline passed/);
    expect(r.report.gaps.join("\n")).toMatch(/602/);
  });

  it("keeps a PR created in the window but closed after it (low-head path)", async () => {
    const r = await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({
          prs: [
            listing(403, {
              state: "CLOSED",
              createdAt: IN,
              mergedAt: null,
              closedAt: "2026-10-01T00:00:00Z",
            }),
          ],
          capped: false,
        }),
        reviewedHeads: async () => 0,
      }),
    );
    expect(r.report.counts.prs).toBe(1);
  });

  it("keeps a sampled PR created in the window but closed after it", async () => {
    const r = await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({
          prs: [
            listing(404, {
              state: "CLOSED",
              createdAt: IN,
              mergedAt: null,
              closedAt: "2026-10-01T00:00:00Z",
            }),
          ],
          capped: false,
        }),
        reviewedHeads: async () => ROUND_FREE + 1,
        samplePr: async () => sampleOf([review("a", "2026-09-20T00:00:00Z")]),
      }),
    );
    expect(r.report.counts.prs).toBe(1);
  });

  it("reports the churn share as not measured when only COMMITS, not reviews, land after the window", async () => {
    const r = await runFleetHealth(
      OPTS,
      deps({
        listCandidates: async () => ({ prs: [listing(210)], capped: false }),
        reviewedHeads: async () => ROUND_FREE + 5,
        samplePr: async () =>
          sampleOf(
            [review("a", "2026-09-10T00:00:00Z")],
            [
              { oid: "c1", committedDate: "2026-09-02T00:00:00Z" },
              { oid: "c2", committedDate: "2026-09-20T00:00:00Z" },
            ],
          ),
      }),
    );
    expect(r.report.caveats.join("\n")).toMatch(
      /after this window's end.*#210/,
    );
    const pr = r.report.prs.find((p) => p.number === 210);
    expect(pr?.postReviewShare).toBeNull();
    expect(
      r.report.signals.filter((s) => s.kind === "review-carousel"),
    ).toEqual([]);
  });
});

describe("follow-up walk: a cycle cut is path-dependent and never memoised", () => {
  const followup = (id: string, origin: number) =>
    issue(id, {
      labels: ["follow-up"],
      description: `Review deferral from PR example-org/example-repo#${origin} round 9.`,
    });

  it("lets an origin reached along a different path continue where the first path was cut", async () => {
    // A(101)->B(102)->C(103)->A(101) is a cycle; D(104)->E(105)->C(103). Walking A first cuts C
    // at A. D then reaches C along a path that does NOT contain A, so C must
    // continue through A and B, giving D a deeper chain than the cut C alone.
    const byPr = new Map<number, IssueFact[]>([
      [101, [followup("F1", 102)]],
      [102, [followup("F2", 103)]],
      [103, [followup("F3", 101)]],
      [104, [followup("F4", 105)]],
      [105, [followup("F5", 103)]],
    ]);
    const memo = new Map<string, Promise<DepthResult>>();
    const a = await followupDepth(101, depsOf(byPr), 6, memo);
    expect(a.truncated).toBe(true);
    const alone = await followupDepth(104, depsOf(byPr), 6, new Map());
    const shared = await followupDepth(104, depsOf(byPr), 6, memo);
    expect(shared.depth).toBe(alone.depth);
    expect(shared.chain).toEqual(alone.chain);
  });
});

describe("an unparsed diagnosis is scoped to its signal and superseded by later events", () => {
  const NOW = Date.parse("2026-09-15T00:00:00Z");
  const cm = (createdAt: string, body: string) => ({
    createdAt,
    body,
    trusted: true,
  });
  const badDepth = cm(
    "2026-09-01T00:00:00Z",
    "**diagnosis** — follow-up depth — bogus-verdict — x",
  );

  it("blocks the signal it names but not a different one on the same epic", () => {
    expect(deriveLifecycle("followup-depth", [badDepth], NOW, 14).state).toBe(
      "unknown",
    );
    expect(deriveLifecycle("ceremony-ratio", [badDepth], NOW, 14).state).toBe(
      "new",
    );
  });

  it("blocks every signal when the comment names no known kind", () => {
    const anon = cm("2026-09-01T00:00:00Z", "Diagnosis: this is fine");
    expect(deriveLifecycle("ceremony-ratio", [anon], NOW, 14).state).toBe(
      "unknown",
    );
  });

  it("stops blocking once a later diagnosis for the signal exists", () => {
    const later = cm(
      "2026-09-05T00:00:00Z",
      "**diagnosis** — follow-up depth — false-positive — fine",
    );
    expect(
      deriveLifecycle("followup-depth", [badDepth, later], NOW, 14).state,
    ).toBe("cooling-down");
  });

  it("stops blocking once a later sensor presentation exists", () => {
    const presented = cm(
      "2026-09-05T00:00:00Z",
      `presented\n${suspicionMarker("followup-depth")}`,
    );
    expect(
      deriveLifecycle("followup-depth", [badDepth, presented], NOW, 14).state,
    ).toBe("awaiting-diagnosis");
  });

  it("still blocks when the well-formed event is OLDER than the malformed comment", () => {
    const earlier = cm(
      "2026-08-20T00:00:00Z",
      "**diagnosis** — follow-up depth — established — real",
    );
    expect(
      deriveLifecycle("followup-depth", [earlier, badDepth], NOW, 14).state,
    ).toBe("unknown");
  });
});

describe("a listing with no activity inside the window", () => {
  it("drops an open PR created before the window and updated only after it", async () => {
    const r = await runFleetHealth(
      OPTS,
      deps({
        reviewedHeads: async () => 0,
        listCandidates: async () => ({
          prs: [
            listing(9, {
              state: "OPEN",
              createdAt: "2026-07-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              updatedAt: "2026-09-20T00:00:00Z",
            }),
            listing(10, {
              state: "OPEN",
              createdAt: "2026-07-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              updatedAt: IN,
            }),
          ],
          capped: false,
        }),
      }),
    );
    expect(r.report.counts.prs).toBe(1);
  });
});

describe("stuck-epic keepalive", () => {
  const old = new Date(
    UNTIL - (CFG.signals.stuckEpic.days + 1) * DAY,
  ).toISOString();
  const fact = {
    epic: "ENG-100",
    startedAt: old,
    children: [{ issue: "ENG-101", updatedAt: old }],
  };
  it("uses the configured threshold, epic start, and newest child activity", () => {
    const boundary = new Date(
      UNTIL - CFG.signals.stuckEpic.days * DAY,
    ).toISOString();
    expect(
      stuckEpicSignal(
        { ...fact, children: [{ issue: "ENG-101", updatedAt: boundary }] },
        UNTIL,
        CFG,
      )?.kind,
    ).toBe("stuck-epic");
    expect(
      stuckEpicSignal(
        { ...fact, startedAt: new Date(UNTIL - DAY).toISOString() },
        UNTIL,
        CFG,
      ),
    ).toBeNull();
    expect(
      stuckEpicSignal(
        {
          ...fact,
          children: [
            ...fact.children,
            {
              issue: "ENG-102",
              updatedAt: new Date(UNTIL - DAY).toISOString(),
            },
          ],
        },
        UNTIL,
        CFG,
      ),
    ).toBeNull();
    expect(stuckEpicSignal({ ...fact, children: [] }, UNTIL, CFG)).toBeNull();
    expect(() =>
      stuckEpicSignal({ ...fact, startedAt: "unreadable" }, UNTIL, CFG),
    ).toThrow("Unreadable");
  });
  it("shares the suspected, diagnosis and cleared/cooldown lifecycle", () => {
    const report = (comments: CommentFact[]) =>
      buildReport({
        ...units(),
        nowMs: UNTIL,
        epicActivity: [fact],
        depthByPr: new Map(),
        epicComments: new Map([["ENG-100", comments]]),
        delivery: null,
        gaps: [],
        caveats: [],
      });
    const first = report([]);
    expect(
      first.signals.find((s) => s.kind === "stuck-epic")?.lifecycle?.state,
    ).toBe("new");
    const signal = first.signals.find((s) => s.kind === "stuck-epic")!;
    const body = suspicionComment(
      { kind: "stuck-epic", epic: "ENG-100", signals: [signal] },
      first,
    );
    const posted = {
      body,
      createdAt: new Date(UNTIL - 2 * DAY).toISOString(),
      trusted: true,
    };
    expect(
      report([posted]).signals.find((s) => s.kind === "stuck-epic")?.lifecycle
        ?.state,
    ).toBe("awaiting-diagnosis");
    const diagnosed = {
      body: "**diagnosis** — stuck-epic — false-positive — waiting for planned approval",
      createdAt: new Date(UNTIL - DAY).toISOString(),
      trusted: true,
    };
    const cleared = report([posted, diagnosed]);
    expect(
      cleared.signals.find((s) => s.kind === "stuck-epic")?.lifecycle?.state,
    ).toBe("cooling-down");
    expect(activeSignals(cleared).some((s) => s.kind === "stuck-epic")).toBe(
      false,
    );
  });
  it("reaches the dashboard report without recent PR or window-issue activity", async () => {
    const tracker = STUB_TRACKER;
    const result = await runFleetHealth(
      OPTS,
      deps({ tracker, fetchEpicActivity: async () => [fact] }),
    );
    expect(
      result.report.signals.find((s) => s.kind === "stuck-epic")?.scope,
    ).toEqual({ type: "epic", epic: "ENG-100" });
    const duringRead = await runFleetHealth(
      OPTS,
      deps({
        tracker,
        fetchEpicActivity: async () => [
          {
            ...fact,
            children: [
              {
                issue: "ENG-101",
                updatedAt: new Date(UNTIL + 2 * DAY).toISOString(),
              },
            ],
          },
        ],
      }),
    );
    expect(duringRead.report.signals.some((s) => s.kind === "stuck-epic")).toBe(
      false,
    );
    expect(duringRead.report.gaps).toEqual([]);
    const partial = await runFleetHealth(
      OPTS,
      deps({
        tracker,
        fetchEpicActivity: async () => {
          throw new Error("truncated epic page");
        },
      }),
    );
    expect(partial.report.gaps.join(" ")).toContain("truncated epic page");
  });
});
