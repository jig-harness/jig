// What the workflow-convention lint's rules share: the finding they return,
// where in a workflow's text a finding points, and how a job's `if:`, needs and
// steps read.
import type { Finding } from "../../../../lib/findings.ts";
import type { Action, Job, Settings, Workflow } from "./inputs.ts";

export interface Found extends Finding {
  file: string;
  job?: string | undefined;
}

export interface Pipelines {
  workflows: Workflow[];
  actions: Action[];
  settings: Settings;
}

export const README =
  "modules/M13-pipeline-economy/reference/workflow-conventions/README.md";
export const PR_EVENTS = ["pull_request", "pull_request_target"];

export const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The 1-based line of the first line matching `pattern` at or after `from`. */
export function lineOf(
  raw: string,
  pattern: RegExp,
  from = 0,
): number | undefined {
  const lines = raw.split(/\r?\n/);
  for (let i = from; i < lines.length; i++)
    if (pattern.test(lines[i] ?? "")) return i + 1;
  return undefined;
}

export const topKey = (name: string) => new RegExp(`^["']?${name}["']?\\s*:`);

/** The line of `name:` directly inside the top-level block `block:` (`jobs`,
 * `on`): only keys at the block's own indentation, before the next
 * top-level key, count, so a step or filter of the same name does not. */
function blockKeyLine(
  raw: string,
  block: string,
  name: string,
): number | undefined {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => topKey(block).test(l));
  if (start < 0) return undefined;
  let indent: string | undefined;
  const key = new RegExp(`^["']?${escapeRegExp(name)}["']?\\s*:`);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const lead = line.match(/^\s*/)?.[0] ?? "";
    if (!lead) return undefined;
    indent ??= lead;
    if (lead === indent && key.test(line.slice(lead.length))) return i + 1;
  }
  return undefined;
}

const jobLine = (wf: Workflow, id: string) => blockKeyLine(wf.raw, "jobs", id);

export const triggerLine = (wf: Workflow, event?: string) =>
  (event ? blockKeyLine(wf.raw, "on", event) : undefined) ??
  lineOf(wf.raw, topKey("on"));

export function at(wf: Workflow, job: Job | undefined, rule: string) {
  return (problem: string, remedy: string): Found => ({
    rule,
    file: wf.file,
    line: job ? jobLine(wf, job.id) : triggerLine(wf),
    job: job?.id,
    problem,
    remedy,
  });
}

export const condition = (job: Job) =>
  job.def.if === undefined ? "" : String(job.def.if);

/** An `if:` without its optional `\${{ }}` wrapper. */
export const bare = (cond: string) =>
  cond
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .trim();

/** The `&&`-joined terms of an expression, split outside parentheses and
 * quoted strings. Undefined when an `||` stands anywhere outside a string, or
 * the quotes or parentheses do not balance: then no single term decides
 * whether the job runs. */
export function conjuncts(expr: string): string[] | undefined {
  const terms: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    // A quote inside a string is doubled (''), which toggles twice.
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (expr.startsWith("||", i)) return undefined;
    else if (depth === 0 && expr.startsWith("&&", i)) {
      terms.push(expr.slice(start, i).trim());
      start = i + 2;
      i++;
    }
    if (depth < 0) return undefined;
  }
  if (quoted || depth) return undefined;
  terms.push(expr.slice(start).trim());
  return terms;
}

// inputs.ts has checked the shapes: `needs` is a job id or a list of them.
export const needs = (job: Job): string[] =>
  typeof job.def.needs === "string"
    ? [job.def.needs]
    : ((job.def.needs as string[] | undefined) ?? []);

export const isPullRequest = (wf: Workflow) =>
  PR_EVENTS.some((event) => event in wf.on);

/** A reusable-workflow call: its timeout is the called workflow's jobs'. */
export const callsWorkflow = (job: Job) => typeof job.def.uses === "string";

export const runs = (step: Record<string, unknown>) => step.run !== undefined;

/** Whether a failure of the job or step fails its caller: no
 * `continue-on-error`, or one that is plainly false. */
export const failsOnError = (def: Record<string, unknown>) =>
  def["continue-on-error"] === undefined || def["continue-on-error"] === false;

// inputs.ts has checked the shape: `steps` is a list of maps.
export const steps = (job: Job) =>
  (job.def.steps as Record<string, unknown>[] | undefined) ?? [];
