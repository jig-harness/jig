/**
 * The reader side of the execution-plan block format.
 *
 * A planner writes an epic's execution plan into the epic's description as a
 * fenced JSON block under an `Execution Plan` heading:
 *
 *   ## Execution Plan
 *   ```execution-plan-v1
 *   { "epic": "ENG-100", "intent": "…", "steps": […], "edges": […], "gates": […] }
 *   ```
 *
 * Issue pickup reads it to choose the next issue. This module is the format
 * contract: it validates the block strictly and refuses anything it cannot
 * read, because a guessed plan would start work out of order. The block name
 * is the consumer's (`do_issue.execution_plan_block`, default
 * `execution-plan-v1`); `__tests__/fixtures/*-execution-plan.md` pin the
 * format.
 */

export const DEFAULT_BLOCK = "execution-plan-v1";

export interface PlanEdge {
  from: string;
  to: string;
  kind: "dependency" | "conflict";
  reason: string;
  conflictSurfaceKinds?: string[];
  conflictFiles?: string[];
  /** The predecessor parks after merge (manual operations), so merge ends the conflict. */
  manualOpsPredecessor?: true;
}

export interface ExecutionPlan {
  epic: string;
  intent: string;
  steps: Array<{
    issue: string;
    band: number;
    lane: string;
    gate: "agent" | "human";
  }>;
  edges: Array<PlanEdge & { completion: "done" | "merged" }>;
  gates: Array<{ issue: string; gate: "human"; reason: string }>;
}

const SURFACE_KINDS = new Set([
  "repository-files",
  "operator-state",
  "shared-data",
  "external-system",
]);

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Z][A-Z0-9]*-\d+$/.test(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;
/** Rendered inline as prose, so a newline could open a block the plan never had. */
const line = (v: unknown): v is string => text(v) && !/[\r\n]/.test(v);

/** Render a plan as its fenced block (the writer's form). */
export function renderExecutionPlan(
  plan: ExecutionPlan,
  block = DEFAULT_BLOCK,
): string {
  return `\`\`\`${block}\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

function closingFence(open: string): RegExp {
  return new RegExp(`^ {0,3}${open.charAt(0)}{${open.length},}\\s*$`);
}

/** Fence-aware: is there a real (non-example) `Execution Plan` heading? */
export function hasExecutionPlanHeading(description: string): boolean {
  const lines = description.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i] ?? "";
    const fence = FENCE.exec(current);
    if (fence) {
      const closing = closingFence(fence[1] ?? "```");
      while (++i < lines.length && !closing.test(lines[i] ?? ""));
      continue;
    }
    if (HEADING.exec(current)?.[2] === "Execution Plan") return true;
  }
  return false;
}

function validateEdge(e: Record<string, unknown>): void {
  if (!["dependency", "conflict"].includes(e.kind as string))
    throw new Error("Malformed execution plan edge");
  if (
    e.kind !== "conflict" &&
    (e.conflictSurfaceKinds !== undefined ||
      e.conflictFiles !== undefined ||
      e.manualOpsPredecessor !== undefined)
  )
    throw new Error(
      "Malformed execution plan edge: conflict surfaces belong only on conflict edges",
    );
  const surfaces = e.conflictSurfaceKinds;
  if (
    surfaces !== undefined &&
    (!Array.isArray(surfaces) ||
      surfaces.length === 0 ||
      surfaces.some((s) => !SURFACE_KINDS.has(s as string)) ||
      new Set(surfaces).size !== surfaces.length)
  )
    throw new Error("Malformed execution plan edge: conflictSurfaceKinds");
  const files = e.conflictFiles;
  if (
    files !== undefined &&
    (!Array.isArray(files) ||
      files.length === 0 ||
      !files.every(line) ||
      new Set(files).size !== files.length)
  )
    throw new Error("Malformed execution plan edge: conflictFiles");
  const repoFiles =
    Array.isArray(surfaces) && surfaces.includes("repository-files");
  if (repoFiles !== (files !== undefined))
    throw new Error(
      "Malformed execution plan edge: repository-file conflicts and conflictFiles go together",
    );
  if (e.manualOpsPredecessor !== undefined && e.manualOpsPredecessor !== true)
    throw new Error("Malformed execution plan edge: manualOpsPredecessor");
  if (!line(e.reason)) throw new Error("Malformed execution plan edge reason");
}

/**
 * The plan in `description`, `null` when there is none. A block outside the
 * `Execution Plan` section, an unclosed or duplicated block, or any field
 * that fails validation throws: missing is distinct from malformed, and
 * machine facts are never inferred from prose.
 */
export function readExecutionPlan(
  description: string,
  block = DEFAULT_BLOCK,
): ExecutionPlan | null {
  const lines = description.split(/\r?\n/);
  let section = false;
  let sectionLevel = 0;
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i] ?? "";
    const fence = FENCE.exec(current);
    if (fence) {
      const tag = (fence[2] ?? "").trim();
      const body: string[] = [];
      const closing = closingFence(fence[1] ?? "```");
      while (++i < lines.length && !closing.test(lines[i] ?? ""))
        body.push(lines[i] ?? "");
      if (tag === block) {
        if (!section) throw new Error(`${block} must be inside Execution Plan`);
        if (i === lines.length) throw new Error(`Unclosed ${block} fence`);
        blocks.push(body.join("\n"));
      }
      continue;
    }
    const heading = HEADING.exec(current);
    if (heading) {
      const level = (heading[1] ?? "").length;
      if (heading[2] === "Execution Plan") {
        section = true;
        sectionLevel = level;
      } else if (level <= sectionLevel) section = false;
    }
  }
  const first = blocks[0];
  if (first === undefined) return null;
  if (blocks.length !== 1) throw new Error(`Duplicate ${block} blocks`);
  const p: unknown = JSON.parse(first);
  if (
    !object(p) ||
    !id(p.epic) ||
    !line(p.intent) ||
    !Array.isArray(p.steps) ||
    !Array.isArray(p.edges) ||
    !Array.isArray(p.gates)
  )
    throw new Error(`Malformed ${block}`);
  const exactKeys = (v: Record<string, unknown>, keys: string[]) => {
    if (Object.keys(v).some((k) => !keys.includes(k)))
      throw new Error(`Unknown ${block} field`);
  };
  exactKeys(p, ["epic", "intent", "steps", "edges", "gates"]);
  const steps = new Map<string, Record<string, unknown>>();
  for (const s of p.steps) {
    if (
      !object(s) ||
      !id(s.issue) ||
      steps.has(s.issue) ||
      !Number.isInteger(s.band) ||
      (s.band as number) < 1 ||
      !text(s.lane) ||
      !["agent", "human"].includes(s.gate as string)
    )
      throw new Error(`Malformed ${block} step`);
    exactKeys(s, ["issue", "band", "lane", "gate"]);
    steps.set(s.issue, s);
  }
  const edgeKeys = new Set<string>();
  for (const e of p.edges) {
    if (
      !object(e) ||
      !id(e.from) ||
      !id(e.to) ||
      e.from === e.to ||
      !["dependency", "conflict"].includes(e.kind as string) ||
      !text(e.reason) ||
      !["done", "merged"].includes(e.completion as string)
    )
      throw new Error(`Malformed ${block} edge`);
    exactKeys(e, [
      "from",
      "to",
      "kind",
      "reason",
      "completion",
      "conflictSurfaceKinds",
      "conflictFiles",
      "manualOpsPredecessor",
    ]);
    const key = `${e.from}>${e.to}`;
    if (edgeKeys.has(key)) throw new Error(`Duplicate ${block} edge`);
    edgeKeys.add(key);
    const mergeOnlyShape =
      e.kind === "conflict" &&
      Array.isArray(e.conflictSurfaceKinds) &&
      e.conflictSurfaceKinds.length === 1 &&
      e.conflictSurfaceKinds[0] === "repository-files" &&
      Array.isArray(e.conflictFiles) &&
      e.conflictFiles.length > 0;
    if (
      e.completion === "merged" &&
      (!mergeOnlyShape || !(e.conflictFiles as unknown[]).every(text))
    )
      throw new Error("Malformed merge-only conflict");
    // Explicit merge-only metadata must not be downgraded to a 'done' edge.
    if (
      e.completion === "done" &&
      mergeOnlyShape &&
      e.manualOpsPredecessor === true
    )
      throw new Error("Merge-only conflict must declare completion merged");
    const from = steps.get(e.from);
    const to = steps.get(e.to);
    if (from && to && (from.band as number) >= (to.band as number))
      throw new Error(`Execution plan bands contradict edges (${block})`);
    validateEdge(e);
  }
  const gates = new Set<string>();
  for (const g of p.gates) {
    if (
      !object(g) ||
      !id(g.issue) ||
      g.gate !== "human" ||
      !line(g.reason) ||
      gates.has(g.issue)
    )
      throw new Error(`Malformed ${block} gate`);
    exactKeys(g, ["issue", "gate", "reason"]);
    const step = steps.get(g.issue);
    if (step && step.gate !== "human")
      throw new Error("Human gate contradicts execution step");
    gates.add(g.issue);
  }
  return p as unknown as ExecutionPlan;
}

/** Every human checkpoint: `gates[]` plus any step marked human without an entry. */
export function humanGates(plan: ExecutionPlan): ExecutionPlan["gates"] {
  return [
    ...plan.gates,
    ...plan.steps
      .filter(
        (s) =>
          s.gate === "human" && !plan.gates.some((g) => g.issue === s.issue),
      )
      .map((s) => ({
        issue: s.issue,
        gate: "human" as const,
        reason: "Execution step is marked human",
      })),
  ];
}

export interface LiveIssue {
  /** State category: triage, backlog, unstarted, started, completed, canceled. */
  state: string;
  blockedBy: string[];
}

/**
 * The plan's issues that may start now, in band order. Live state and
 * explicit evidence win over the rendered plan: an issue is eligible when it
 * is open, every live blocker is completed, and every plan edge into it is
 * satisfied (a merge-only conflict edge by verified merge evidence, any other
 * edge by its predecessor's completion). Bands are not barriers.
 */
export function eligibleIssues(
  plan: ExecutionPlan,
  live: Record<string, LiveIssue>,
  mergedConflictEdges: string[],
): string[] {
  const complete = (issue: string) => live[issue]?.state === "completed";
  return plan.steps
    .slice()
    .sort((a, b) => a.band - b.band)
    .filter((s) => {
      const current = live[s.issue];
      if (
        !current ||
        !["triage", "backlog", "unstarted", "started"].includes(
          current.state,
        ) ||
        !Array.isArray(current.blockedBy)
      )
        return false;
      if (!current.blockedBy.every(complete)) return false;
      return plan.edges
        .filter((e) => e.to === s.issue)
        .every((e) =>
          e.completion === "merged"
            ? mergedConflictEdges.includes(`${e.from}>${e.to}`)
            : complete(e.from),
        );
    })
    .map((s) => s.issue);
}
