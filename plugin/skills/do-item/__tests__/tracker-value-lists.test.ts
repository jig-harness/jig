import { describe, expect, it } from "bun:test";
import {
  facetInputs,
  parseTrackerConfig,
} from "../scripts/lib/tracker/config.ts";
import {
  resolveFacets,
  type ResolvedFacet,
  type TaxonomyValues,
} from "../scripts/lib/tracker/facets/config.ts";
import { labelCodec } from "../scripts/lib/tracker/facets/label.ts";
import { everyName, valueMap } from "../scripts/lib/tracker/facets/values.ts";
import { gitHubModel } from "../scripts/lib/tracker/github/model.ts";
import { jiraModel } from "../scripts/lib/tracker/jira/model.ts";
import { parseJiraSettings } from "../scripts/lib/tracker/jira/settings.ts";
import {
  gitHub,
  issueNode,
  JIG_TAXONOMY,
  oneIssue,
  repoLabels,
} from "./github-fixtures.ts";
import { issue, jira, page, routes } from "./jira-fixtures.ts";

/** A site's eight priorities, onto Jig's four. */
const EIGHT = {
  urgent: ["Blocker", "Critical", "Highest"],
  high: "High",
  medium: "Medium",
  low: ["Low", "Lowest", "Trivial"],
};

const RESOLUTIONS = {
  canceled: ["Won't Do", "Won't Fix", "Declined"],
  duplicate: "Duplicate",
};

const TAXONOMY: TaxonomyValues = {
  path: "label-taxonomy.yaml",
  ...JIG_TAXONOMY,
};

function jiraConfig(jiraSection: Record<string, unknown>, extra = {}) {
  return parseTrackerConfig({
    issue_tracker: {
      adapter: "jira",
      team: "ENG",
      jira: { site: "https://example.atlassian.net", ...jiraSection },
      ...extra,
    },
  });
}

/** One Done status for every closed state, which the resolution tells apart. */
const ONE_DONE = {
  states: { done: "Done", canceled: "Done", duplicate: "Done" },
};

const model = (jiraSection: Record<string, unknown>, extra = {}) => {
  const config = jiraConfig(jiraSection, extra);
  return jiraModel(config.states, config.jira);
};

const closed = (m: ReturnType<typeof model>, resolution: string | null) =>
  m.closedState({
    status: { id: "9", name: "Done", category: "done" },
    resolution,
  });

describe("a value map that reads several names and writes the first", () => {
  it("reads each listed name as its value and writes the first", () => {
    const map = valueMap(
      ["bug", "feature"],
      { feature: ["Story", "Improvement"] },
      "where",
    );
    expect(
      ["story", "Improvement", "Bug", "Epic"].map(map.fromTracker),
    ).toEqual(["feature", "feature", "bug", null]);
    expect(map.toTracker("feature")).toBe("Story");
    expect(map.entries).toEqual([
      ["bug", "bug"],
      ["feature", "Story"],
    ]);
    expect(map.names).toEqual([
      ["bug", ["bug"]],
      ["feature", ["Story", "Improvement"]],
    ]);
  });

  it("refuses a name listed for two values, or twice for one", () => {
    expect(() =>
      valueMap(
        ["bug", "feature"],
        { bug: ["Defect", "Story"], feature: ["story"] },
        "where",
      ),
    ).toThrow("gives bug and feature the one tracker value 'story'");
    expect(() =>
      valueMap(["bug", "feature"], { feature: ["Story", "story"] }, "where"),
    ).toThrow("names 'story' twice");
    expect(() => valueMap(["bug"], { bug: [] }, "where")).toThrow(
      "where.bug names no tracker value",
    );
  });
});

describe("issue_tracker.jira.priorities: several names per priority", () => {
  it("reads every listed name as its priority and writes the first", () => {
    const m = model({ priorities: EIGHT });
    expect(
      [
        "Blocker",
        "critical",
        "Highest",
        "High",
        "Medium",
        "Low",
        "Lowest",
        "Trivial",
        "Unheard",
      ].map(m.priorityOf),
    ).toEqual([1, 1, 1, 2, 3, 4, 4, 4, 0]);
    expect([1, 2, 3, 4].map(m.priorityName)).toEqual([
      "Blocker",
      "High",
      "Medium",
      "Low",
    ]);
  });

  it("keeps a plain string's meaning, and the defaults for priorities left out", () => {
    const m = model({ priorities: { urgent: "Blocker" } });
    expect(["Blocker", "Highest", "High"].map(m.priorityOf)).toEqual([1, 0, 2]);
    expect(m.priorityName(1)).toBe("Blocker");
  });

  it("refuses a name repeated across two priorities", () => {
    expect(() =>
      parseJiraSettings({
        priorities: { urgent: ["Blocker", "High"] },
      }),
    ).toThrow(
      "issue_tracker.jira.priorities gives urgent and high the one priority 'High' (high's default)",
    );
    expect(() =>
      parseJiraSettings({ priorities: { low: ["Lowest", "lowest"] } }),
    ).toThrow("names 'lowest' twice");
    expect(() => parseJiraSettings({ priorities: { low: [] } })).toThrow(
      "issue_tracker.jira.priorities.low names no priority",
    );
  });

  it("files and reads an issue through the listed names", async () => {
    const PRIORITIES = {
      values: ["Blocker", "Critical", "High", "Medium", "Low"].map(
        (name, i) => ({ id: String(i + 1), name }),
      ),
      startAt: 0,
      maxResults: 100,
      isLast: true,
    };
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-7": issue({ key: "ENG-7", priority: "Critical" }),
        "POST search/jql": page(),
        "GET priority/search": PRIORITIES,
        "POST issue": { id: "10050", key: "ENG-50" },
      }),
      { issue_tracker: { jira: { priorities: EIGHT } } },
    );
    expect((await t.getIssue("ENG-7"))?.priority).toBe(1);
    await t.createIssue({
      title: "New",
      description: "",
      labels: [],
      type: "bug",
      priority: 1,
    });
    const fields = calls.at(-1)?.body.fields as Record<string, unknown>;
    expect(fields.priority).toEqual({ id: "1" });
  });
});

describe("issue_tracker.jira.resolutions: several names per closed state", () => {
  it("reads every listed resolution as its state and writes the first", () => {
    const m = model({ resolutions: RESOLUTIONS }, ONE_DONE);
    expect(
      ["Won't Do", "won't fix", "Declined", "Duplicate", "Done", null].map(
        (r) => closed(m, r),
      ),
    ).toEqual([
      "canceled",
      "canceled",
      "canceled",
      "duplicate",
      "done",
      "done",
    ]);
    expect(m.resolutionOf("canceled")).toBe("Won't Do");
  });

  it("keeps a plain string's meaning", () => {
    const m = model({ resolutions: { canceled: "Won't Fix" } }, ONE_DONE);
    expect([closed(m, "Won't Fix"), closed(m, "Won't Do")]).toEqual([
      "canceled",
      "done",
    ]);
  });

  it("refuses a name repeated across two closed states", () => {
    expect(() =>
      parseJiraSettings({
        resolutions: { canceled: ["Won't Do", "Duplicate"] },
      }),
    ).toThrow(
      "gives canceled and duplicate the one resolution 'Duplicate' (duplicate's default)",
    );
  });

  it("lets the closed states share one status only while every resolution differs", () => {
    expect(() =>
      jiraConfig({ resolutions: RESOLUTIONS }, ONE_DONE),
    ).not.toThrow();
    expect(() =>
      jiraConfig({ resolutions: { canceled: ["Won't Do", "Done"] } }, ONE_DONE),
    ).toThrow(
      "gives done and canceled the one resolution 'Done' (done's default)",
    );
  });
});

describe("a type map with several names per type", () => {
  const typeOf = (section: Record<string, unknown>) =>
    resolveFacets(
      facetInputs(parseTrackerConfig({ issue_tracker: section })),
      TAXONOMY,
    ).type as ResolvedFacet;

  it("reads every listed issue type as its type and files as the first", () => {
    const type = typeOf({
      adapter: "jira",
      team: "ENG",
      jira: { site: "https://example.atlassian.net" },
      facets: {
        type: {
          store: "native",
          values: { feature: ["Story", "Improvement"] },
        },
      },
    });
    expect(type.map?.fromTracker("Improvement")).toBe("feature");
    expect(type.map?.fromTracker("Story")).toBe("feature");
    expect(type.map?.toTracker("feature")).toBe("Story");
    expect(type.named).toEqual(["feature"]);
  });

  it("reads every listed label as its type and writes the first", () => {
    const codec = labelCodec(
      typeOf({
        facets: {
          type: {
            store: "label",
            labels: {
              feature: ["kind:feature", "kind:story"],
              bug: "kind:bug",
            },
          },
        },
      }),
    );
    expect(
      [["kind:story"], ["kind:feature"], ["kind:bug"]].map(codec.read),
    ).toEqual(["feature", "feature", "bug"]);
    expect(codec.labelOf("feature")).toBe("kind:feature");
    expect(codec.change(["kind:story"], "feature")).toEqual({
      add: ["kind:feature"],
      remove: ["kind:story"],
    });
  });

  it("reads a number field's value as the value any listed number names", () => {
    const size = resolveFacets(
      facetInputs(
        parseTrackerConfig({
          issue_tracker: {
            facets: {
              size: {
                store: "field",
                field: "Points",
                values: { large: [5, 8], xl: 13 },
              },
            },
          },
        }),
      ),
      TAXONOMY,
    ).size as ResolvedFacet;
    expect(
      everyName(size.map).filter(([v]) => v === "large" || v === "xl"),
    ).toEqual([
      ["large", "5"],
      ["large", "8"],
      ["xl", "13"],
    ]);
    expect(size.map?.fromTracker("8")).toBe("large");
    expect(size.map?.toTracker("large")).toBe("5");
  });

  it("refuses a listed type label issue_tracker.types gives another type", () => {
    const section = (labels: Record<string, unknown>) => ({
      types: { feature: ["feat", "story"], bug: ["bug"] },
      facets: { type: { store: "label", labels } },
    });
    expect(() =>
      typeOf(section({ feature: ["feat", "story"], bug: "bug" })),
    ).not.toThrow();
    expect(() =>
      typeOf(section({ feature: "feat", bug: ["bug", "story"] })),
    ).toThrow("keeps type bug in the label 'story'");
  });

  it("refuses a name repeated across two types", () => {
    expect(() =>
      typeOf({
        facets: {
          type: {
            store: "label",
            labels: { feature: ["kind:feature", "kind:x"], bug: "kind:x" },
          },
        },
      }),
    ).toThrow("one label would set two facts");
    expect(() =>
      typeOf({
        facets: {
          type: {
            store: "native",
            values: { feature: ["Story", "Bug"], bug: "Bug" },
          },
        },
      }),
    ).toThrow("the one tracker value 'Bug'");
  });
});

describe("issue_tracker.github.priority_labels: several labels per priority", () => {
  const config = parseTrackerConfig({
    issue_tracker: {
      github: { priority_labels: { urgent: ["P0", "sev:1"], high: "P1" } },
    },
  });
  const m = gitHubModel(config.states, config.github);

  it("reads every listed label as its priority, writes the first and reserves them all", () => {
    expect([["sev:1"], ["P0"], ["P1"], ["x"]].map(m.priorityOf)).toEqual([
      1, 1, 2, 0,
    ]);
    expect(m.priorityLabel(1)).toBe("P0");
    expect(m.visibleLabels(["sev:1", "P0", "area:x"])).toEqual(["area:x"]);
    const priority = labelCodec(
      resolveFacets(facetInputs(config), TAXONOMY).priority,
    );
    expect(priority.read(["sev:1"])).toBe("urgent");
    expect(priority.labelOf("urgent")).toBe("P0");
  });

  it("refuses a label repeated across two priorities", () => {
    expect(() =>
      parseTrackerConfig({
        issue_tracker: {
          github: { priority_labels: { urgent: ["P0", "P1"], high: "P1" } },
        },
      }),
    ).toThrow("gives urgent and high the one label 'P1'");
  });
});

describe("today's priority keys beside a facet entry, both with lists", () => {
  it("accepts the same list, and refuses a list that differs in an alias or its order", () => {
    const rest = { high: "P1", medium: "P2", low: "P3" };
    const github = (urgent: unknown, labels: unknown) =>
      parseTrackerConfig({
        issue_tracker: {
          github: { priority_labels: { urgent, ...rest } },
          facets: {
            priority: { store: "label", labels: { urgent: labels, ...rest } },
          },
        },
      });
    expect(
      github(["P0", "sev:1"], ["P0", "sev:1"]).github.priorityLabels.urgent,
    ).toEqual(["P0", "sev:1"]);
    for (const labels of [["sev:1", "P0"], "P0", ["P0", "sev:2"]])
      expect(() => github(["P0", "sev:1"], labels)).toThrow(
        "keep one, or make them agree",
      );
    const jiraBoth = (priorities: unknown, values: unknown) =>
      jiraConfig(
        { priorities: { urgent: priorities } },
        {
          facets: { priority: { store: "native", values: { urgent: values } } },
        },
      );
    expect(
      jiraBoth(["Blocker", "Highest"], ["blocker", "highest"]).jira.priorities
        .urgent,
    ).toEqual(["blocker", "highest"]);
    expect(() => jiraBoth(["Blocker", "Highest"], "Blocker")).toThrow(
      "keep one, or make them agree",
    );
  });

  it("refuses a name the facet entry gives one priority and today's key another", () => {
    expect(() =>
      jiraConfig(
        { priorities: { high: "Major" } },
        {
          facets: {
            priority: {
              store: "native",
              values: { urgent: ["Blocker", "Major"] },
            },
          },
        },
      ),
    ).toThrow(
      "issue_tracker.facets.priority.values gives urgent and high the one priority 'Major'",
    );
    expect(() =>
      jiraConfig(
        {},
        {
          facets: {
            priority: {
              store: "native",
              values: { urgent: ["Blocker", "High"] },
            },
          },
        },
      ),
    ).toThrow("gives urgent and high the one tracker value 'high'");
  });
});

describe("a GitHub priority change through a listed label", () => {
  it("takes an alias label off and writes the first label", async () => {
    const { t, calls } = gitHub(
      (c) => {
        if (c.op === "TrackerIssue")
          return oneIssue(issueNode({ number: 5, labels: ["sev:1", "bug"] }));
        if (c.op === "TrackerLabels") return repoLabels("bug", "sev:1", "P1");
        return {};
      },
      {
        issue_tracker: {
          github: { priority_labels: { urgent: ["P0", "sev:1"], high: "P1" } },
        },
      },
    );
    await t.updateIssue("#5", { priority: 2 });
    expect(
      calls.find((c) => c.op === "TrackerAddLabels")?.variables.labelIds,
    ).toEqual(["LA_2_P1"]);
    expect(
      calls.find((c) => c.op === "TrackerRemoveLabels")?.variables.labelIds,
    ).toEqual(["LA_1_sev:1"]);
  });
});
