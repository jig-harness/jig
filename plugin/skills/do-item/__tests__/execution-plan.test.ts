/**
 * The execution-plan block format, read at pickup. The fixtures are the
 * contract: `plan-epic-execution-plan.md` and `linear-issue-execution-plan.md`
 * are descriptions as two planners write them, and the reader must select the
 * same issues from both.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPlanBlocks } from "../scripts/lib/plan-blocks.ts";
import {
  type ExecutionPlan,
  humanGates,
  readExecutionPlan,
  renderExecutionPlan,
} from "../scripts/lib/execution-plan.ts";
import {
  executionPlanBlock,
  selectExecutionIssue,
} from "../scripts/select_execution_issue.ts";

const fixture = (producer: string) =>
  readFileSync(
    join(import.meta.dirname, "fixtures", `${producer}-execution-plan.md`),
    "utf8",
  );
const live = {
  "ENG-1": { state: "unstarted", blockedBy: [] },
  "ENG-2": { state: "unstarted", blockedBy: [] },
  "ENG-3": { state: "unstarted", blockedBy: ["ENG-1"] },
};
const input = (description: string) => ({
  description,
  epic: "ENG-100",
  live,
  mergedConflictEdges: [] as string[],
});
const plan = readExecutionPlan(fixture("linear-issue")) as ExecutionPlan;
const md = (p: unknown) =>
  `## Execution Plan\n\n\`\`\`execution-plan-v1\n${JSON.stringify(p)}\n\`\`\``;
describe("shared execution-plan-v1 pickup", () => {
  for (const producer of ["linear-issue", "plan-epic"]) {
    it(`preserves selection and gates for ${producer}'s human shape`, () => {
      const first = selectExecutionIssue(input(fixture(producer)));
      expect(first.eligible).toEqual(["ENG-1", "ENG-2"]);
      expect(first.gates).toEqual([
        { issue: "ENG-2", gate: "human", reason: "approve copy" },
      ]);
      const next = selectExecutionIssue({
        ...input(fixture(producer)),
        live: { ...live, "ENG-1": { state: "completed", blockedBy: [] } },
      });
      // ENG-2 need not finish before ENG-3 starts: bands are not barriers.
      expect(next.eligible).toEqual(["ENG-2", "ENG-3"]);
      expect(
        selectExecutionIssue({ ...input(fixture(producer)), live: {} })
          .eligible,
      ).toEqual([]);
    });
  }
  it("selects the same issues from a plan keyed by GitHub issue numbers", () => {
    const github = (v: unknown) =>
      JSON.parse(JSON.stringify(v).replace(/"ENG-(\d+)"/g, '"#$1"'));
    const result = selectExecutionIssue({
      description: md(github(plan)),
      epic: "#100",
      live: github(live),
      mergedConflictEdges: ["#1>#3"],
    });
    expect(result.eligible).toEqual(["#1", "#2"]);
    expect(() =>
      selectExecutionIssue({ ...input(md(plan)), epic: "#0" }),
    ).toThrow("Malformed");
    expect(() => readExecutionPlan(md({ ...plan, epic: "eng-100" }))).toThrow();
  });
  it("reads legal fences and ignores heading decoys inside other fences", () => {
    const canonical = renderExecutionPlan(plan);
    for (const fence of ["```", "~~~~", "````"]) {
      const variant = canonical
        .replace(/^```/gm, fence)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
      expect(readExecutionPlan(`## Execution Plan\n${variant}`)).toEqual(plan);
    }
    expect(
      readExecutionPlan(`\`\`\`md\n## Execution Plan\n\`\`\`\n`),
    ).toBeNull();
    expect(() => readExecutionPlan(`## Other\n${canonical}`)).toThrow("inside");
  });
  it("refuses malformed, duplicate and prose-only plans instead of changing selection", () => {
    expect(() =>
      selectExecutionIssue(input("## Execution Plan\n### Steps\n1. ENG-1")),
    ).toThrow("re-run");
    expect(selectExecutionIssue(input("## Scope\nNo plan.")).present).toBe(
      false,
    );
    expect(() =>
      readExecutionPlan(`${md(plan)}\n${renderExecutionPlan(plan)}`),
    ).toThrow("Duplicate");
    expect(() =>
      readExecutionPlan(md({ ...plan, steps: [...plan.steps, plan.steps[0]] })),
    ).toThrow("step");
    expect(() =>
      readExecutionPlan(md({ ...plan, gates: [...plan.gates, plan.gates[0]] })),
    ).toThrow("gate");
    expect(() =>
      readExecutionPlan(
        md({ ...plan, steps: plan.steps.map((s) => ({ ...s, band: 1 })) }),
      ),
    ).toThrow("bands");
    expect(() =>
      readExecutionPlan(
        md({ ...plan, gates: [{ ...plan.gates[0], issue: "ENG-1" }] }),
      ),
    ).toThrow("contradicts");
    expect(() => readExecutionPlan(md({ ...plan, unexpected: true }))).toThrow(
      "Unknown",
    );
    expect(() =>
      selectExecutionIssue({ ...input(md(plan)), epic: "ENG-101" }),
    ).toThrow("different epic");
  });
  it("treats a heading inside a fenced example as no plan at pickup", () => {
    const decoy = "```md\n## Execution Plan\n```\n";
    expect(selectExecutionIssue(input(decoy))).toEqual({
      present: false,
      eligible: [],
      gates: [],
    });
  });
  it("surfaces a step-level human gate that has no gates[] entry", () => {
    const unlisted = { ...plan, gates: [] };
    expect(
      selectExecutionIssue(input(md(unlisted))).gates.map((g) => g.issue),
    ).toEqual(["ENG-2"]);
  });
  it("shares step-level gate normalization with direct pickup via humanGates", () => {
    const unlisted = { ...plan, gates: [] };
    expect(humanGates(unlisted).map((g) => g.issue)).toEqual(["ENG-2"]);
    expect(humanGates(plan)).toEqual(plan.gates);
  });
  it("rejects explicit merge-only metadata declared as a done edge", () => {
    const downgraded = {
      from: "ENG-1",
      to: "ENG-3",
      kind: "conflict",
      reason: "same file",
      completion: "done",
      conflictSurfaceKinds: ["repository-files"],
      conflictFiles: ["tools/shared.ts"],
      manualOpsPredecessor: true,
    };
    expect(() =>
      readExecutionPlan(md({ ...plan, edges: [downgraded] })),
    ).toThrow("completion merged");
  });
  it("keeps a completed or canceled predecessor ineligible without merge evidence", () => {
    const conflict = {
      from: "ENG-1",
      to: "ENG-3",
      kind: "conflict",
      reason: "same file",
      completion: "merged",
      conflictSurfaceKinds: ["repository-files"],
      conflictFiles: ["tools/shared.ts"],
      manualOpsPredecessor: true,
    };
    for (const state of ["completed", "canceled"]) {
      const base = {
        ...input(md({ ...plan, edges: [conflict] })),
        live: {
          ...live,
          "ENG-1": { state, blockedBy: [] },
          "ENG-3": { state: "unstarted", blockedBy: [] },
        },
      };
      expect(selectExecutionIssue(base).eligible).not.toContain("ENG-3");
      expect(
        selectExecutionIssue({ ...base, mergedConflictEdges: ["ENG-1>ENG-3"] })
          .eligible,
      ).toContain("ENG-3");
    }
  });
  it("refuses a plan whose dependency edge the tracker's blocks contradict, and names both issues", () => {
    // The plan puts ENG-1 before ENG-3; the tracker says ENG-1 waits for ENG-3.
    const reversed = {
      ...input(fixture("linear-issue")),
      live: { ...live, "ENG-1": { state: "unstarted", blockedBy: ["ENG-3"] } },
    };
    expect(() => selectExecutionIssue(reversed)).toThrow(
      "ENG-1 is blocked by ENG-3 in the tracker, but the plan puts ENG-1 first",
    );
    // A dependency the tracker does not state yet is not a contradiction: the plan's edge holds.
    expect(
      selectExecutionIssue({
        ...input(fixture("linear-issue")),
        live: { ...live, "ENG-3": { state: "unstarted", blockedBy: [] } },
      }).eligible,
    ).not.toContain("ENG-3");
  });
  it("ignores a contradicting relation once either issue is finished", () => {
    for (const done of ["ENG-1", "ENG-3"])
      expect(() =>
        selectExecutionIssue({
          ...input(fixture("linear-issue")),
          live: {
            ...live,
            "ENG-1": { state: "unstarted", blockedBy: ["ENG-3"] },
            [done]: {
              state: "completed",
              blockedBy: done === "ENG-1" ? ["ENG-3"] : [],
            },
          },
        }),
      ).not.toThrow();
  });
  it("refuses a tracker blocker that the plan places in a later band", () => {
    const noEdges = md({ ...plan, edges: [] });
    expect(() =>
      selectExecutionIssue({
        ...input(noEdges),
        live: {
          ...live,
          "ENG-1": { state: "unstarted", blockedBy: ["ENG-3"] },
        },
      }),
    ).toThrow("contradicts the tracker's blocks");
  });
  // The two guards below are exercised in isolation: with ENG-1 in both
  // ENG-3's live blockedBy and its incoming done edge, either guard alone
  // excludes ENG-3 and masks a regression in the other.
  it("never treats a canceled predecessor as delivered on a live blocker alone", () => {
    const noEdge = md({ ...plan, edges: [] });
    const withBlocker = (state: string) => ({
      ...input(noEdge),
      live: {
        ...live,
        "ENG-1": { state, blockedBy: [] },
        "ENG-3": { state: "unstarted", blockedBy: ["ENG-1"] },
      },
    });
    expect(
      selectExecutionIssue(withBlocker("canceled")).eligible,
    ).not.toContain("ENG-3");
    expect(selectExecutionIssue(withBlocker("completed")).eligible).toContain(
      "ENG-3",
    );
  });
  it("never treats a canceled predecessor as delivered on a plan done edge alone", () => {
    const withEdge = (state: string) => ({
      ...input(md(plan)),
      live: {
        ...live,
        "ENG-1": { state, blockedBy: [] },
        "ENG-3": { state: "unstarted", blockedBy: [] },
      },
    });
    expect(selectExecutionIssue(withEdge("canceled")).eligible).not.toContain(
      "ENG-3",
    );
    expect(selectExecutionIssue(withEdge("completed")).eligible).toContain(
      "ENG-3",
    );
  });
  it("requires verified per-edge merge evidence, even for a terminal predecessor", () => {
    const conflict = {
      from: "ENG-1",
      to: "ENG-3",
      kind: "conflict",
      reason: "same file",
      completion: "merged",
      conflictSurfaceKinds: ["repository-files"],
      conflictFiles: ["tools/shared.ts"],
      manualOpsPredecessor: true,
    };
    const description = md({ ...plan, edges: [conflict] });
    const start = {
      ...input(description),
      live: {
        ...live,
        "ENG-1": { state: "started", blockedBy: [] },
        "ENG-3": { state: "unstarted", blockedBy: [] },
      },
    };
    expect(selectExecutionIssue(start).eligible).toEqual(["ENG-1", "ENG-2"]);
    expect(
      selectExecutionIssue({ ...start, mergedConflictEdges: ["ENG-1>ENG-3"] })
        .eligible,
    ).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    expect(() =>
      readExecutionPlan(
        md({ ...plan, edges: [{ ...conflict, kind: "dependency" }] }),
      ),
    ).toThrow();
    expect(() =>
      selectExecutionIssue({
        ...start,
        live: { ...live, "ENG-1": { state: "unknown", blockedBy: [] } },
      }),
    ).toThrow("live");
  });
  it("reads the block name the consumer configures", () => {
    const custom = fixture("plan-epic").replace(
      "```execution-plan-v1",
      "```delivery-plan",
    );
    expect(readExecutionPlan(custom)).toBeNull();
    expect(readExecutionPlan(custom, "delivery-plan")).toEqual(plan);
    expect(
      selectExecutionIssue(input(custom), "delivery-plan").eligible,
    ).toEqual(["ENG-1", "ENG-2"]);
    expect(executionPlanBlock(null)).toBe("execution-plan-v1");
    expect(
      executionPlanBlock({
        do_item: { execution_plan_block: "delivery-plan" },
      }),
    ).toBe("delivery-plan");
    expect(() =>
      executionPlanBlock({ do_item: { execution_plan_block: "a b" } }),
    ).toThrow("fenced-block name");
    expect(() =>
      executionPlanBlock({ do_issue: { execution_plan_block: "x" } }),
    ).toThrow("now called do_item");
  });
  it("selects through the CLI with the overlay's block name", () => {
    const dir = mkdtempSync(join(tmpdir(), "execution-plan-"));
    try {
      writeFileSync(
        join(dir, "overlay.yaml"),
        "do_item:\n  execution_plan_block: delivery-plan\n",
      );
      const description = fixture("plan-epic").replace(
        "```execution-plan-v1",
        "```delivery-plan",
      );
      const r = spawnSync(
        process.execPath,
        [join(import.meta.dir, "..", "scripts", "select_execution_issue.ts")],
        {
          encoding: "utf8",
          input: JSON.stringify(input(description)),
          env: {
            ...process.env,
            JIG_OVERLAY: join(dir, "overlay.yaml"),
          },
        },
      );
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout).eligible).toEqual(["ENG-1", "ENG-2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writing a plan's dependency edges to the tracker", () => {
  const tracker = (written: string[]) => {
    const relations: Record<
      string,
      Array<{ type: string; issue: string }>
    > = {};
    return {
      getIssue: async () =>
        ({ description: fixture("linear-issue") }) as { description: string },
      listRelations: async (key: string) => relations[key] ?? [],
      relate: async (from: string, type: string, to: string) => {
        written.push(`${from} ${type} ${to}`);
        relations[from] = [...(relations[from] ?? []), { type, issue: to }];
      },
    };
  };
  it("writes each dependency edge as blocks once, and no conflict edge", async () => {
    const written: string[] = [];
    const t = tracker(written) as never;
    const first = await syncPlanBlocks(t, "ENG-100");
    expect(first.present).toBe(true);
    expect(written).toEqual(["ENG-1 blocks ENG-3"]);
    const again = await syncPlanBlocks(t, "ENG-100");
    expect(again.written).toEqual([]);
    expect(again.existing).toEqual([{ from: "ENG-1", to: "ENG-3" }]);
    expect(written).toHaveLength(1);
  });
  it("writes nothing on a dry run", async () => {
    const written: string[] = [];
    const report = await syncPlanBlocks(tracker(written) as never, "ENG-100", {
      dryRun: true,
    });
    expect(report.written).toEqual([{ from: "ENG-1", to: "ENG-3" }]);
    expect(written).toEqual([]);
  });
  it("refuses to write a blocks the tracker already has the other way", async () => {
    const t = {
      getIssue: async () => ({ description: fixture("linear-issue") }),
      listRelations: async () => [{ type: "blocked_by", issue: "ENG-3" }],
      relate: async () => undefined,
    };
    await expect(syncPlanBlocks(t as never, "ENG-100")).rejects.toThrow(
      "ENG-3 blocks ENG-1",
    );
  });
});
