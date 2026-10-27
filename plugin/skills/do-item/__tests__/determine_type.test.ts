/**
 * determine_type.ts: the work-type derivation's steps and their order,
 * the depth table's defaults and overrides, the computed `unknown` row, and
 * every configuration the loading rules refuse.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  deriveType,
  type IssueFacts,
  issueFacts,
  type TitleConvention,
} from "../scripts/determine_type.ts";
import { getIssue } from "../scripts/get_issue.ts";
import { numberKeys, teamKeys } from "../scripts/lib/tracker/keys.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { linearTracker } from "../scripts/lib/tracker/linear.ts";
import {
  DEFAULT_ROWS,
  DEFAULT_TYPES,
  depthOf,
  parseWorkTypes,
  unknownRow,
} from "../scripts/lib/work-types.ts";
import { conn, gitHub, issueNode, oneIssue } from "./github-fixtures.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "determine_type.ts");

const CONVENTIONAL: TitleConvention = {
  value: "conventional",
  source: "pull_requests.title_format",
};
const FREE: TitleConvention = { value: "free", source: "default" };

const issue = (over: Partial<IssueFacts> = {}): IssueFacts => ({
  labels: [],
  title: "Something",
  nativeType: null,
  ...over,
});

/** Derive with the given configuration and title convention. */
const derive = (
  facts: IssueFacts,
  config: Record<string, unknown> = {},
  convention: TitleConvention = CONVENTIONAL,
) => deriveType(facts, parseWorkTypes(config), async () => convention);

describe("the derivation's steps", () => {
  it("types an issue by a type label, ignoring case", async () => {
    const v = await derive(issue({ labels: ["frontend", "Type:Feature"] }));
    expect(v.type).toBe("feature");
    expect(v.evidence).toMatchObject({
      step: "label",
      matched: "Type:Feature",
    });
    expect(v.depth).toEqual(DEFAULT_ROWS.feature);
  });

  it("reads bug's labels from issue_tracker.labels.bug", async () => {
    const config = { issue_tracker: { labels: { bug: ["defect"] } } };
    expect((await derive(issue({ labels: ["defect"] }), config)).type).toBe(
      "bug",
    );
    expect((await derive(issue({ labels: ["bug"] }), config)).type).toBe(
      "unknown",
    );
  });

  it("types an issue by the tracker's own type, ignoring case", async () => {
    const v = await derive(issue({ nativeType: "Bug" }));
    expect(v.type).toBe("bug");
    expect(v.evidence).toMatchObject({ step: "tracker_type", matched: "Bug" });
  });

  it("leaves the tracker's type unanswered when it names no type, and says so", async () => {
    const v = await derive(
      issue({ nativeType: "Incident", title: "docs: explain" }),
    );
    expect(v.type).toBe("task");
    expect(v.evidence.step).toBe("title_prefix");
    expect(v.evidence.unanswered).toEqual([
      {
        step: "tracker_type",
        reason: expect.stringContaining("Incident"),
      },
    ]);
  });

  for (const [title, type] of [
    ["fix: login loops", "bug"],
    ["feat(auth)!: passkeys", "feature"],
    ["chore: bump", "task"],
    ["docs: guide", "task"],
    ["refactor: split", "improvement"],
    ["Perf: cache", "improvement"],
  ] as const)
    it(`types "${title}" as ${type} under the conventional title convention`, async () => {
      const v = await derive(issue({ title }));
      expect(v.type).toBe(type);
      expect(v.evidence.step).toBe("title_prefix");
    });

  it("reads no prefix when the title convention is free", async () => {
    const v = await derive(issue({ title: "fix: login" }), {}, FREE);
    expect(v.type).toBe("unknown");
    expect(v.evidence.unanswered[0]?.reason).toContain("free");
  });

  it("leaves a prefix whose type the repository dropped unanswered", async () => {
    const config = {
      issue_tracker: { types: { bug: ["bug"], feature: ["feature"] } },
    };
    const v = await derive(issue({ title: "refactor: split" }), config);
    expect(v.type).toBe("unknown");
    expect(v.evidence.unanswered).toEqual([
      {
        step: "title_prefix",
        reason: expect.stringContaining("refactor:"),
      },
    ]);
  });

  it("leaves a prefix that names no work type unanswered", async () => {
    const v = await derive(issue({ title: "test: cover" }));
    expect(v.type).toBe("unknown");
    expect(v.evidence.unanswered[0]?.step).toBe("title_prefix");
  });

  it("does not read the title convention when an earlier step answered", async () => {
    let asked = 0;
    const v = await deriveType(
      issue({ labels: ["bug"], title: "feat: x" }),
      parseWorkTypes({}),
      async () => {
        asked++;
        return CONVENTIONAL;
      },
    );
    expect([v.type, asked]).toEqual(["bug", 0]);
  });
});

describe("the derivation's order", () => {
  it("takes a label over the tracker's type and the title prefix", async () => {
    const v = await derive(
      issue({ labels: ["spike"], nativeType: "Bug", title: "feat: x" }),
    );
    expect([v.type, v.evidence.step]).toEqual(["spike", "label"]);
  });

  it("takes the tracker's type over the title prefix", async () => {
    const v = await derive(issue({ nativeType: "Task", title: "feat: x" }));
    expect([v.type, v.evidence.step]).toEqual(["task", "tracker_type"]);
  });

  it("answers unknown when labels mark two types, whatever comes after", async () => {
    const v = await derive(
      issue({ labels: ["bug", "feature"], nativeType: "Bug" }),
    );
    expect(v.type).toBe("unknown");
    expect(v.evidence.summary).toContain("more than one type");
    expect(v.evidence.summary).toContain("removing or correcting");
    expect(v.evidence.summary).not.toContain("a type label clears it");
  });

  it("answers unknown, with the strictest depth, when nothing identifies the type", async () => {
    const v = await derive(issue());
    expect(v).toMatchObject({
      type: "unknown",
      evidence: { step: "none", matched: null, unanswered: [] },
    });
    expect(v.depth).toEqual(unknownRow(parseWorkTypes({})));
  });
});

describe("the depth table", () => {
  it("holds the default rows for the default types", () => {
    const wt = parseWorkTypes({});
    expect(wt.types).toEqual([...DEFAULT_TYPES]);
    expect(wt.labels.feature).toEqual(["feature", "type:feature"]);
    expect(wt.labels.bug).toEqual(["bug", "type:bug"]);
    for (const t of DEFAULT_TYPES)
      expect(depthOf(wt, t)).toEqual(DEFAULT_ROWS[t]);
  });

  it("composes unknown field by field as the strictest of the rows", () => {
    expect(unknownRow(parseWorkTypes({}))).toEqual({
      pre_scouts: ["pattern", "spec"],
      test_first: "required",
      review_tiers: [1, 2, 3],
      review_skip_lines: "never",
      change_note: "required",
      batchable: "no",
      autonomy: "hitl",
      pr_body_sections: [
        "reproduction",
        "cause",
        "fix",
        "requirements_covered",
        "left_out",
        "before_and_after",
        "what_changed",
        "findings",
        "recommendation",
      ],
    });
  });

  it("overrides one field and keeps the rest of the row", () => {
    const wt = parseWorkTypes({
      do_item: { work_types: { task: { review_skip_lines: 80 } } },
    });
    expect(depthOf(wt, "task")).toEqual({
      ...DEFAULT_ROWS.task,
      review_skip_lines: 80,
    });
  });

  it("cannot lighten unknown through an override, and widens it through one", () => {
    const wt = parseWorkTypes({
      do_item: {
        work_types: {
          bug: { test_first: "none", review_tiers: [1], batchable: "yes" },
          task: { pr_body_sections: ["what_changed", "rollout"] },
        },
      },
    });
    const row = unknownRow(wt);
    expect(row).toMatchObject({
      test_first: "required",
      review_tiers: [1, 2, 3],
      batchable: "no",
      autonomy: "hitl",
    });
    expect(row.pr_body_sections).toContain("rollout");
  });

  it("keeps a default row's list entries in unknown when an override shortens them", () => {
    const row = unknownRow(
      parseWorkTypes({
        do_item: {
          work_types: { bug: { pre_scouts: [], pr_body_sections: ["fix"] } },
        },
      }),
    );
    expect(row.pre_scouts).toContain("pattern");
    expect(row.pr_body_sections).toEqual(
      expect.arrayContaining(["reproduction", "cause"]),
    );
  });

  it("drops a default type left out of issue_tracker.types with its row", () => {
    const wt = parseWorkTypes({
      issue_tracker: { types: { bug: ["bug"], task: ["task"] } },
    });
    expect(wt.types).toEqual(["bug", "task"]);
    expect(Object.hasOwn(wt.rows, "feature")).toBe(false);
    expect(unknownRow(wt).pre_scouts).toEqual(["pattern"]);
  });

  it("takes a type outside the default list with its complete row", async () => {
    const chore = { ...DEFAULT_ROWS.task, review_tiers: [] };
    const config = {
      issue_tracker: { types: { bug: ["bug"], chore: ["chore"] } },
      do_item: { work_types: { chore } },
    };
    const v = await derive(issue({ labels: ["chore"] }), config);
    expect([v.type, v.depth]).toEqual(["chore", chore]);
  });
});

describe("the loading rules refuse", () => {
  const refusals: Array<[string, Record<string, unknown>, string]> = [
    [
      "a type outside the default list without a complete row",
      {
        issue_tracker: { types: { chore: ["chore"] } },
        do_item: { work_types: { chore: { autonomy: "full" } } },
      },
      "do_item.work_types.chore: chore is not a default type",
    ],
    [
      "a type outside the default list with no row at all",
      { issue_tracker: { types: { chore: ["chore"] } } },
      "missing: pre_scouts",
    ],
    [
      "an entry for a type outside the set",
      {
        issue_tracker: { types: { bug: ["bug"] } },
        do_item: { work_types: { feature: { autonomy: "full" } } },
      },
      "do_item.work_types.feature: feature is not a type of this repository",
    ],
    [
      "unknown as a type",
      { issue_tracker: { types: { unknown: ["triage"] } } },
      "issue_tracker.types.unknown",
    ],
    [
      "unknown as a row",
      { do_item: { work_types: { unknown: { autonomy: "full" } } } },
      "do_item.work_types.unknown",
    ],
    [
      "a label under two types",
      { issue_tracker: { types: { bug: ["defect"], task: ["Defect"] } } },
      "lists the label 'Defect'",
    ],
    [
      "a default type label another default type's label shares",
      { issue_tracker: { labels: { bug: ["bug", "task"] } } },
      "issue_tracker.types.task lists the label 'task'",
    ],
    [
      "bug's labels named differently in two places",
      {
        issue_tracker: {
          types: { bug: ["defect"] },
          labels: { bug: ["bug"] },
        },
      },
      "issue_tracker.types.bug (defect) and issue_tracker.labels.bug (bug)",
    ],
    [
      "an empty type map",
      { issue_tracker: { types: {} } },
      "issue_tracker.types must map at least one type",
    ],
    [
      "a type name that is not lowercase",
      { issue_tracker: { types: { Bug: ["bug"] } } },
      "issue_tracker.types.Bug",
    ],
    [
      "labels that are not a list",
      { issue_tracker: { types: { bug: "bug" } } },
      "issue_tracker.types.bug must be a list",
    ],
    [
      "a field the table does not have",
      { do_item: { work_types: { task: { reviewers: 2 } } } },
      "do_item.work_types.task.reviewers is not a depth-table field",
    ],
    [
      "a value outside a field's set",
      { do_item: { work_types: { task: { autonomy: "partial" } } } },
      "do_item.work_types.task.autonomy must be one of hitl, full",
    ],
    [
      "a review tier that does not exist",
      { do_item: { work_types: { task: { review_tiers: [4] } } } },
      "do_item.work_types.task.review_tiers",
    ],
    [
      "a negative skip threshold",
      { do_item: { work_types: { task: { review_skip_lines: -1 } } } },
      "do_item.work_types.task.review_skip_lines",
    ],
    [
      "a pre-scout that does not exist",
      { do_item: { work_types: { bug: { pre_scouts: ["fuzz"] } } } },
      "do_item.work_types.bug.pre_scouts",
    ],
    [
      "a type label the GitHub adapter reads as a state",
      { issue_tracker: { types: { task: ["In Progress"] } } },
      "issue_tracker.types.task lists the label 'In Progress', which the GitHub adapter reads as a workflow state or a priority",
    ],
    ["the renamed do_issue section", { do_issue: {} }, "now called do_item"],
  ];
  for (const [what, config, message] of refusals)
    it(what, () => {
      expect(() => parseWorkTypes(config)).toThrow(message);
    });

  it("leaves a state's name free as a type label outside the GitHub adapter", () => {
    const config = {
      issue_tracker: {
        adapter: "linear",
        team: "ENG",
        types: { task: ["In Progress"] },
      },
    };
    expect(parseWorkTypes(config).labels.task).toEqual(["In Progress"]);
  });
});

describe("issue input", () => {
  it("reads an issue printed before nativeType existed as having none", () => {
    expect(issueFacts({ labels: ["bug"], title: "t" })).toEqual({
      labels: ["bug"],
      title: "t",
      nativeType: null,
    });
  });

  it("refuses a nativeType that is not text", () => {
    expect(issueFacts({ nativeType: 3 })).toContain("nativeType");
  });
});

describe("from get_issue.ts to the type", () => {
  it("types a GitHub issue by its issue type", async () => {
    const { t } = gitHub(() =>
      oneIssue(
        issueNode({
          number: 4,
          issueType: "Feature",
          extra: { subIssues: conn([]) },
        }),
      ),
    );
    const printed = await getIssue("#4", t, numberKeys("acme/app"));
    expect(printed.nativeType).toBe("Feature");
    const facts = issueFacts(printed) as IssueFacts;
    expect((await derive(facts)).type).toBe("feature");
  });

  it("prints a Linear issue's nativeType as null", async () => {
    const t = linearTracker({
      team: "ENG",
      states: parseTrackerConfig({}).states,
      transport: async () => ({
        issue: {
          id: "uuid-1",
          identifier: "ENG-1",
          title: "fix: crash",
          description: null,
          url: null,
          state: { name: "Todo", type: "unstarted" },
          labels: conn([]),
          parent: null,
          children: conn([]),
          assignee: null,
          project: null,
        },
      }),
    });
    const printed = await getIssue("ENG-1", t, teamKeys("ENG"));
    expect(printed).toMatchObject({ found: true, nativeType: null });
    const facts = issueFacts(printed) as IssueFacts;
    expect((await derive(facts)).evidence.step).toBe("title_prefix");
  });
});

describe("determine_type.ts", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** Run the script in a scratch repository with `config` as its configuration. */
  const run = (config: string, input: string, args: string[] = ["-"]) => {
    const dir = mkdtempSync(join(tmpdir(), "determine-type-"));
    dirs.push(dir);
    const overlay = join(dir, "jig.yaml");
    writeFileSync(overlay, config);
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      input,
      encoding: "utf8",
      env: { ...process.env, JIG_OVERLAY: overlay, JIG_CONSUMER_ROOT: dir },
    });
    return { ...r, exitCode: r.status };
  };

  it("prints the type, its evidence and its depth", () => {
    const r = run(
      "pull_requests:\n  title_format: conventional\n",
      JSON.stringify({ labels: [], title: "chore: tidy", nativeType: null }),
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toEqual({
      type: "task",
      evidence: {
        step: "title_prefix",
        matched: "chore:",
        summary: "title prefix chore: (pull_requests.title_format)",
        unanswered: [],
      },
      depth: DEFAULT_ROWS.task,
    });
  });

  it("reads the issue from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "determine-type-input-"));
    dirs.push(dir);
    const file = join(dir, "issue.json");
    writeFileSync(file, JSON.stringify({ labels: ["type:spike"], title: "x" }));
    const r = run("{}\n", "", [file]);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).type).toBe("spike");
  });

  it("refuses a configuration the loading rules refuse, naming the file", () => {
    const r = run(
      "do_item:\n  work_types:\n    unknown: { autonomy: full }\n",
      JSON.stringify({ labels: ["bug"], title: "x" }),
    );
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("do_item.work_types.unknown");
    expect(r.stderr).toContain("jig.yaml");
  });

  it("refuses input that is not an issue as a usage error", () => {
    expectSpawnExit(run("{}\n", "not json"), 2);
    expectSpawnExit(run("{}\n", '{"labels":"bug"}'), 2);
  });
});
