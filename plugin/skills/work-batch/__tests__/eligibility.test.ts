/**
 * `excludeReason`: which issues may join a batch, fail-closed, and which one
 * reason each held-back issue reports.
 */
import { describe, expect, it } from "bun:test";
import {
  describeReason,
  excludeReason,
  partition,
  sanitizeForDisplay,
} from "../scripts/lib/eligibility.ts";
import { parseCatalog } from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { issue, policy, relabel } from "./helpers.ts";

const none = { claimed: new Set<string>() };
const P = policy({
  work_batch: {
    sizes: ["xs", "small", "medium", "large", "xl"],
    solo_flags: ["privacy-review"],
  },
});
const base = issue("ENG-1").labels;

describe("solo-only flags", () => {
  it("admits an issue that carries none", () => {
    expect(excludeReason(issue("ENG-1"), P, none)).toBeNull();
  });

  it("holds back every derived and configured flag, and any hitl facet", () => {
    for (const flag of [
      "hitl",
      "manual-ops",
      "api-review",
      "db-migration",
      "privacy-review",
      "hitl:legal",
    ])
      expect(
        excludeReason(issue("ENG-1", { labels: [...base, flag] }), P, none),
      ).toEqual({ kind: "solo-flag", flag });
  });

  it("reports the flag rather than a later mismatch", () => {
    const labels = relabel(base, ["small", "bug"], ["large", "db-migration"]);
    expect(excludeReason(issue("ENG-1", { labels }), P, none)).toEqual({
      kind: "solo-flag",
      flag: "db-migration",
    });
  });

  it("reads areas and labels named like Object properties as plain names", () => {
    const named = policy(
      {
        do_item: {
          agents: {
            codearea_areas: {
              "area:billing": "billing",
              "area:core": "constructor",
            },
          },
        },
      },
      parseCatalog({
        areas: {
          billing: { paths: ["src/billing/**"] },
          constructor: { paths: ["src/core/**"] },
        },
      }),
    );
    const labels = [...relabel(base, ["area:billing"]), "area:core"];
    expect(excludeReason(issue("ENG-1", { labels }), named, none)).toBeNull();
    for (const label of ["constructor", "__proto__"])
      expect(
        excludeReason(issue("ENG-1", { labels: [...base, label] }), P, none),
      ).toBeNull();
  });

  it("does not hold back the follow-up label: provenance is not a gate", () => {
    expect(
      excludeReason(
        issue("ENG-1", { labels: [...base, "pr-followup"] }),
        P,
        none,
      ),
    ).toBeNull();
  });
});

describe("fail-closed reads", () => {
  it("holds back an issue whose labels came back truncated, before any label verdict", () => {
    const truncated = issue("ENG-1", {
      labels: ["small", "web", "bug", "area:billing"],
      truncated: ["labels"],
    });
    expect(excludeReason(truncated, P, none)).toEqual({
      kind: "truncated",
      lists: ["labels"],
    });
    // Even an issue whose visible labels would admit or refuse it otherwise.
    const flagged = { ...truncated, labels: [...truncated.labels, "hitl"] };
    expect(excludeReason(flagged, P, none)?.kind).toBe("truncated");
  });
});

describe("size", () => {
  it("admits every batchable size and tells no size from too large", () => {
    for (const size of ["xs", "small", "medium"])
      expect(
        excludeReason(
          issue("ENG-1", { labels: relabel(base, ["small"], [size]) }),
          P,
          none,
        ),
      ).toBeNull();
    expect(
      excludeReason(
        issue("ENG-1", { labels: relabel(base, ["small"], ["large"]) }),
        P,
        none,
      ),
    ).toEqual({ kind: "not-batchable-size", size: "large" });
    expect(
      excludeReason(
        issue("ENG-1", { labels: relabel(base, ["small"]) }),
        P,
        none,
      ),
    ).toEqual({ kind: "not-batchable-size", size: null });
  });

  it("holds back two size labels rather than picking one", () => {
    expect(
      excludeReason(issue("ENG-1", { labels: [...base, "large"] }), P, none),
    ).toEqual({ kind: "conflicting-size-labels", sizes: ["large", "small"] });
  });
});

describe("repository, type and context", () => {
  it("holds back another repository, two repositories and none", () => {
    const of = (labels: string[]) =>
      excludeReason(issue("ENG-1", { labels }), P, none);
    expect(of(relabel(base, ["web"], ["api"]))).toEqual({
      kind: "wrong-repo",
      repo: "api",
    });
    expect(of([...base, "api"])).toEqual({
      kind: "conflicting-repo-labels",
      repos: ["api", "web"],
    });
    expect(of(relabel(base, ["web"]))).toEqual({
      kind: "wrong-repo",
      repo: null,
    });
  });

  it("holds back no type and two types", () => {
    const of = (labels: string[]) =>
      excludeReason(issue("ENG-1", { labels }), P, none);
    expect(of(relabel(base, ["bug"]))).toEqual({ kind: "no-type-label" });
    expect(of([...base, "feature"])).toEqual({
      kind: "conflicting-type-labels",
      types: ["bug", "feature"],
    });
  });

  it("skips each check the repository does not configure", () => {
    const bare = policy({ review: {} });
    expect(
      excludeReason(
        issue("ENG-1", { labels: ["small", "area:billing"] }),
        bare,
        none,
      ),
    ).toBeNull();
  });

  it("holds back an issue with no context label", () => {
    expect(
      excludeReason(
        issue("ENG-1", { labels: ["small", "web", "bug"] }),
        P,
        none,
      ),
    ).toEqual({ kind: "no-context-label" });
  });

  it("holds back an issue whose only area labels name no area, and admits one known beside a typo", () => {
    // Without context prefixes the area check alone sees the typo.
    const noContext = policy({
      review: {
        repo_label: "web",
        taxonomy: {
          repos: ["web"],
          types: ["bug"],
          ownership_prefixes: ["team:"],
        },
      },
    });
    expect(
      excludeReason(
        issue("ENG-1", {
          labels: relabel(base, ["area:billing"], ["area:biling"]),
        }),
        noContext,
        none,
      ),
    ).toEqual({ kind: "unknown-area-label", labels: ["area:biling"] });
    expect(
      excludeReason(
        issue("ENG-1", { labels: [...base, "area:biling"] }),
        P,
        none,
      ),
    ).toBeNull();
  });
});

describe("context labels the configuration does not know", () => {
  it("holds back an issue whose every context label is unknown", () => {
    for (const unknown of ["agent:bogus", "domain:typo"])
      expect(
        excludeReason(
          issue("ENG-1", { labels: ["small", "web", "bug", unknown] }),
          P,
          none,
        ),
      ).toEqual({ kind: "unknown-context-label", labels: [unknown] });
  });

  it("knows the labels do_item.agents.labels routes and the catalog's own labels", () => {
    const routed = policy({
      do_item: {
        agents: {
          codearea_areas: { "area:billing": "billing" },
          labels: { "agent:backend": "backend-dev" },
        },
      },
    });
    expect(
      excludeReason(
        issue("ENG-1", { labels: ["small", "web", "bug", "agent:backend"] }),
        routed,
        none,
      ),
    ).toBeNull();
    expect(routed.knownContextLabels).toContain("agent:backend");
    expect(routed.knownContextLabels).toContain("domain:payments");
    // One known context label beside a typo is enough.
    expect(
      excludeReason(
        issue("ENG-1", { labels: [...base, "agent:bogus"] }),
        P,
        none,
      ),
    ).toBeNull();
  });
});

describe("sizes with work_batch.sizes", () => {
  it("still recognises a size only review.taxonomy.sizes lists", () => {
    const both = policy({
      work_batch: { sizes: ["xs", "small", "medium", "large"] },
      review: {
        repo_label: "web",
        taxonomy: {
          repos: ["web"],
          types: ["bug"],
          sizes: ["xl"],
          context_prefixes: ["area:"],
          ownership_prefixes: ["team:"],
        },
      },
    });
    expect(both.knownSizes).toEqual(["xs", "small", "medium", "large", "xl"]);
    expect(
      excludeReason(issue("ENG-1", { labels: [...base, "xl"] }), both, none),
    ).toEqual({ kind: "conflicting-size-labels", sizes: ["small", "xl"] });
  });
});

describe("sizes without work_batch.sizes", () => {
  const unlisted = policy({ work_batch: {} });

  it("holds back two batchable sizes", () => {
    expect(
      excludeReason(
        issue("ENG-1", { labels: [...base, "xs"] }),
        unlisted,
        none,
      ),
    ).toEqual({ kind: "conflicting-size-labels", sizes: ["small", "xs"] });
  });

  it("recognises the sizes review.taxonomy.sizes lists, and says what it cannot see", () => {
    const listed = policy({
      work_batch: {},
      review: {
        repo_label: "web",
        taxonomy: {
          repos: ["web"],
          types: ["bug"],
          sizes: ["xs", "small", "large"],
          context_prefixes: ["area:"],
          ownership_prefixes: ["team:"],
        },
      },
    });
    expect(listed.knownSizes).toEqual(["xs", "small", "medium", "large"]);
    expect(
      excludeReason(
        issue("ENG-1", { labels: [...base, "large"] }),
        listed,
        none,
      ),
    ).toEqual({ kind: "conflicting-size-labels", sizes: ["large", "small"] });
    expect(
      excludeReason(
        issue("ENG-1", { labels: relabel(base, ["small"], ["large"]) }),
        listed,
        none,
      ),
    ).toEqual({ kind: "not-batchable-size", size: "large" });
    expect(
      describeReason({ kind: "not-batchable-size", size: null }, unlisted),
    ).toContain("without work_batch.sizes");
  });
});

describe("work that is not a batch item", () => {
  it("holds back an urgent issue and admits every other priority", () => {
    expect(excludeReason(issue("ENG-1", { priority: 1 }), P, none)).toEqual({
      kind: "urgent",
    });
    for (const priority of [0, 2, 3, 4])
      expect(excludeReason(issue("ENG-1", { priority }), P, none)).toBeNull();
  });

  it("holds back an epic by its label and by its open children", () => {
    expect(
      excludeReason(issue("ENG-1", { labels: [...base, "epic"] }), P, none),
    ).toEqual({ kind: "has-open-children" });
    expect(
      excludeReason(issue("ENG-1", { hasOpenChildren: true }), P, none),
    ).toEqual({ kind: "has-open-children" });
  });

  it("holds back a closed issue", () => {
    for (const type of ["completed", "canceled", "duplicate"])
      expect(
        excludeReason(
          issue("ENG-1", { state: { id: "s", name: "Done", type } }),
          P,
          none,
        ),
      ).toEqual({ kind: "already-closed", state: "Done" });
  });

  it("reads a state with no known category by its name, and holds back one it cannot read", () => {
    const at = (name: string, type: string, p = P) =>
      excludeReason(
        issue("ENG-1", { state: { id: "s", name, type } }),
        p,
        none,
      );
    for (const type of ["", "custom"]) {
      expect(at("Done", type)).toEqual({
        kind: "already-closed",
        state: "Done",
      });
      expect(at("In Progress", type)).toEqual({
        kind: "already-started",
        state: "In Progress",
      });
      expect(at("Backlog", type)).toBeNull();
      expect(at("Someday", type)).toEqual({
        kind: "unknown-state",
        state: "Someday",
      });
    }
    const named = policy({
      issue_tracker: { team: "ENG", states: { backlog: "Someday" } },
    });
    expect(at("someday ", "", named)).toBeNull();
    expect(at("Someday", "backlog")).toBeNull();
  });

  it("reads a state named like an Object property by its configuration only", () => {
    const at = (name: string, p = P) =>
      excludeReason(
        issue("ENG-1", { state: { id: "s", name, type: "" } }),
        p,
        none,
      );
    for (const name of ["constructor", "__proto__", "toString"])
      expect(at(name)).toEqual({ kind: "unknown-state", state: name });
    const done = policy({
      issue_tracker: { team: "ENG", states: { done: "Constructor" } },
    });
    expect(at("Constructor", done)).toEqual({
      kind: "already-closed",
      state: "Constructor",
    });
  });

  it("holds back an issue assigned to someone, even in the backlog, and one started", () => {
    const assigned = issue("ENG-1", { assignee: { id: "u2", name: "Sam" } });
    expect(excludeReason(assigned, P, none)).toEqual({
      kind: "already-assigned",
      assignee: "Sam",
    });
    const started = issue("ENG-2", {
      state: { id: "s-ip", name: "In Progress", type: "started" },
    });
    expect(excludeReason(started, P, none)).toEqual({
      kind: "already-started",
      state: "In Progress",
    });
  });

  it("admits only the started or assigned issues --claimed names", () => {
    const mine = issue("ENG-1", {
      assignee: { id: "u1", name: "Me" },
      state: { id: "s-ip", name: "In Progress", type: "started" },
    });
    const theirs = { ...mine, identifier: "ENG-2" };
    const claimed = { claimed: new Set(["ENG-1"]) };
    expect(excludeReason(mine, P, claimed)).toBeNull();
    expect(excludeReason(theirs, P, claimed)?.kind).toBe("already-assigned");
  });
});

describe("partition and the reasons people read", () => {
  it("accounts for every issue exactly once", () => {
    const issues = [
      issue("ENG-1"),
      issue("ENG-2", { labels: [...base, "hitl"] }),
      issue("ENG-3", { truncated: ["labels"] }),
    ];
    const { eligible, excluded } = partition(issues, P, none);
    expect(eligible.map((i) => i.identifier)).toEqual(["ENG-1"]);
    expect(excluded.map((e) => e.identifier)).toEqual(["ENG-2", "ENG-3"]);
  });

  it("names the label to add", () => {
    expect(describeReason({ kind: "no-type-label" }, P)).toContain(
      "`bug`, `feature`, `chore`",
    );
    expect(
      describeReason({ kind: "not-batchable-size", size: null }, P),
    ).toContain("`xs`, `small`, `medium`");
    expect(describeReason({ kind: "wrong-repo", repo: null }, P)).toContain(
      "`web`",
    );
  });

  it("strips control characters from tracker text", () => {
    expect(sanitizeForDisplay("a\u001b[2Jb\u0007c\u009bd")).toBe("a[2Jbcd");
    expect(
      describeReason({ kind: "already-assigned", assignee: "x\u001b[1Ay" }, P),
    ).not.toContain("\u001b");
  });
});
