/**
 * Every do-item field that selects by an item's facts, pinned: whether case
 * matters, whether the first matching rule wins or every one applies, and
 * whether one listed value is enough. The fixtures fix what each field
 * selects, so a change to how fields match shows here first.
 */
import { describe, expect, it } from "bun:test";
import {
  chooseBase,
  parseBaseRules,
} from "../../drive-pr/scripts/lib/pr-conventions.ts";
import { parsePrPolicy } from "../../drive-pr/scripts/lib/pr-policy.ts";
import { parseCatalog } from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import {
  determineAgents,
  parseAgentRouting,
} from "../scripts/determine_agent.ts";
import { deriveRoute, type RouteFacts } from "../scripts/determine_route.ts";
import { issueSignals } from "../scripts/pr-plan.ts";
import { parseGuidance, resolveGuidance } from "../scripts/lib/guidance.ts";
import { parseRouting } from "../scripts/lib/routing.ts";
import { parseWorkTypes } from "../scripts/lib/work-types.ts";

describe("pull_requests.base_rules", () => {
  const rules = parseBaseRules([
    { when: { labels: ["hotfix", "urgent"] }, base: "release" },
    { when: { labels: ["Hotfix", "docs"] }, base: "docs-branch" },
  ]);
  const base = (labels: string[]) => chooseBase(rules, labels, "main");

  it("takes the first rule one of whose labels the item carries", () => {
    expect(base(["docs", "urgent"]).base).toBe("release");
    expect(base(["docs"]).base).toBe("docs-branch");
  });

  it("matches labels ignoring case and names the item's spelling", () => {
    expect(base(["HOTFIX"])).toEqual({
      base: "release",
      rule: { index: 0, label: "HOTFIX" },
    });
  });

  it("falls back to the integration branch when no rule matches", () => {
    expect(base(["feature"])).toEqual({ base: "main", rule: null });
  });
});

describe("pull_requests.labels_from_issue and reviewers_from_issue", () => {
  const policy = parsePrPolicy({
    pull_requests: {
      labels_from_issue: { Bug: "kind/bug", security: "needs-security" },
      reviewers_from_issue: { security: ["@org/sec", "alice"] },
    },
  });

  it("maps every issue label that a key names, ignoring case, in the issue's order", () => {
    const { labels, reviewers } = issueSignals(policy, [
      "SECURITY",
      "other",
      "bug",
    ]);
    expect(labels.map((l) => l.value)).toEqual(["needs-security", "kind/bug"]);
    expect(reviewers.map((r) => r.value)).toEqual(["org/sec", "alice"]);
  });

  it("maps nothing for labels no key names", () => {
    expect(issueSignals(policy, ["feature"])).toEqual({
      labels: [],
      reviewers: [],
    });
  });
});

describe("do_item.agents", () => {
  const routing = parseAgentRouting({
    do_item: {
      agents: {
        labels: { Frontend: "web-dev", backend: "api-dev" },
        title_keywords: { Migration: "db-dev" },
        codearea_areas: { "AREA:billing": "billing" },
        catalog: { payments: "billing-dev" },
      },
    },
  });
  const catalog = parseCatalog({
    areas: { billing: { paths: ["src/billing/**"], agent: "payments" } },
  });
  const agents = (labels: string[], title = "") =>
    determineAgents(labels, title, catalog, routing).all_agents;

  it("labels: every label a key names chooses its agent, ignoring case", () => {
    expect(agents(["frontend", "BACKEND"])).toEqual(["web-dev", "api-dev"]);
  });

  it("title_keywords: a keyword contained in the title, ignoring case", () => {
    expect(agents([], "Write the MIGRATIONS for x")).toEqual(["db-dev"]);
    expect(agents([], "Write the migrate step")).toEqual(["general-purpose"]);
  });

  it("codearea_areas: a label names an area, ignoring case", () => {
    expect(agents(["area:billing"])).toEqual(["billing-dev"]);
  });
});

describe("do_item.guidance", () => {
  const entries = parseGuidance({
    guidance: [
      { labels: ["DB"], skills: ["migration-safety"] },
      { paths: ["db/**"], notes: "Add a rollback." },
      { labels: ["db"], paths: ["src/**"], skills: ["second"] },
    ],
  });
  const resolve = (labels: string[], paths: string[] | null) =>
    resolveGuidance(entries, labels, paths, [], null);

  it("applies every matching entry, by a label in any case or by a path", () => {
    const g = resolve(["db"], ["db/x.sql"]);
    expect(g.sources.map((s) => [s.from, s.by])).toEqual([
      ["do_item.guidance[0]", "label db"],
      ["do_item.guidance[1]", "path db/x.sql"],
      ["do_item.guidance[2]", "label db"],
    ]);
  });

  it("holds an entry only its paths could match when the paths are not known", () => {
    const g = resolve([], null);
    expect(g.sources).toEqual([]);
    expect(g.byPath.map((b) => b.from)).toEqual([
      "do_item.guidance[1]",
      "do_item.guidance[2]",
    ]);
  });
});

describe("routing", () => {
  const rules = (routing: Record<string, unknown>) => {
    const config = { routing };
    return parseRouting(config, parseWorkTypes(config));
  };
  const facts = (over: Partial<RouteFacts> = {}): RouteFacts => ({
    agent: "general-purpose",
    type: "bug",
    labels: [],
    catalog: { flags: ["catalog-flag"], reviews: [] },
    hitl: "hitl",
    knownSizes: ["small", "large"],
    batchSizes: ["small"],
    runtime: null,
    ...over,
  });

  it("complex_flags: any one listed label, ignoring case, makes the tier complex", () => {
    const r = rules({ complex_flags: ["has-migration", "api-change"] });
    expect(deriveRoute(facts({ labels: ["API-Change"] }), r).tier).toBe(
      "complex",
    );
    expect(deriveRoute(facts({ labels: ["other"] }), r).tier).toBe("standard");
  });

  it("raise.flags: a listed label, ignoring case, raises the effort one step", () => {
    const r = rules({ raise: { flags: ["risky"], reviews: false } });
    expect(deriveRoute(facts({ labels: ["RISKY"] }), r).effort).toBe("high");
    expect(deriveRoute(facts({ labels: ["catalog-flag"] }), r).effort).toBe(
      "medium",
    );
  });

  it("raise.flags catalog: the catalog's flags raise", () => {
    const r = rules({ raise: { flags: "catalog", reviews: false } });
    expect(deriveRoute(facts({ labels: ["Catalog-Flag"] }), r).effort).toBe(
      "high",
    );
  });

  it("raise.sizes: a listed size name, ignoring case, from the size facet or the labels", () => {
    const r = rules({ raise: { sizes: ["large"], reviews: false } });
    expect(deriveRoute(facts({ labels: ["Large"] }), r).effort).toBe("high");
    expect(deriveRoute(facts({ sizes: ["LARGE"] }), r).effort).toBe("high");
    expect(deriveRoute(facts({ sizes: ["L"] }), r).effort).toBe("medium");
    expect(deriveRoute(facts({ sizes: ["small"] }), r).effort).toBe("medium");
  });

  it("raise.sizes unset: the known sizes batch_sizes leaves out", () => {
    const r = rules({ raise: { reviews: false } });
    expect(deriveRoute(facts({ labels: ["large"] }), r).effort).toBe("high");
    expect(deriveRoute(facts({ labels: ["small"] }), r).effort).toBe("medium");
  });
});
