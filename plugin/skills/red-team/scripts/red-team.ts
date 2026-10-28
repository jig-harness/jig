#!/usr/bin/env bun
/**
 * The mechanical half of a red-team review: what the document is and who
 * reads it (`plan`), running each persona as a fresh agent process where the
 * harness has no subagents (`fresh`), checking what a persona reported
 * (`collect`), and writing the one report (`report`). The personas' reading
 * is the agent's work, not this script's.
 *
 *   bun red-team.ts plan <document> [--kind requirements|architecture]
 *                        [--companion <document>] [--out <folder>]
 *   bun red-team.ts collect <folder> <persona> --context subagent|fresh-run|same-session
 *   bun red-team.ts fresh <folder> [--timeout-seconds <n>] [--parallel <n>] -- <agent command>...
 *   bun red-team.ts report <folder>
 *
 * Run from the repository that holds the document. The review's folder is
 * `.context/red-team/<document>/` under the repository root unless `--out`
 * names another. Exit 0 on success; 1 when a persona's findings fail their
 * checks, a persona is missing from the report, a fresh run failed, or the
 * document changed since the plan; 2 on a command line or document it cannot
 * act on.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { git } from "../../../shared/proc.ts";
import { kindOption } from "./lib/document.ts";
import { runFresh } from "./lib/fresh.ts";
import {
  CONTEXTS,
  type Context,
  type Findings,
  checkFindings,
  extractJson,
  readKept,
} from "./lib/findings.ts";
import {
  type Plan,
  type PlannedPersona,
  PlanError,
  makePlan,
  promptFor,
  readPlan,
  unchangedDocument,
} from "./lib/plan.ts";
import { renderReport } from "./lib/report.ts";

const USAGE = [
  "Usage:",
  "  red-team.ts plan <document> [--kind requirements|architecture] [--companion <document>] [--out <folder>]",
  "  red-team.ts collect <folder> <persona> --context subagent|fresh-run|same-session",
  "  red-team.ts fresh <folder> [--timeout-seconds <n>] [--parallel <n>] -- <agent command>...",
  "  red-team.ts report <folder>",
].join("\n");

interface Parsed {
  positional: string[];
  options: Map<string, string>;
  command: string[];
}

function parse(args: string[], known: string[]): Parsed {
  const dash = args.indexOf("--");
  const own = dash === -1 ? args : args.slice(0, dash);
  const command = dash === -1 ? [] : args.slice(dash + 1);
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < own.length; i++) {
    const arg = own[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const value = own[i + 1];
    if (!known.includes(arg) || value === undefined || value.startsWith("--"))
      fail(2, `${arg}: not an option here, or it needs a value`, USAGE);
    options.set(arg, value);
    i += 1;
  }
  return { positional, options, command };
}

function local(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function ignored(
  root: string,
  directory: string,
): Promise<boolean | null> {
  const result = await git(["check-ignore", "-q", directory], {
    cwd: root,
    timeoutSec: 30,
  });
  return result.code === 0 ? true : result.code === 1 ? false : null;
}

async function plan(args: string[]): Promise<number> {
  const { positional, options } = parse(args, [
    "--kind",
    "--companion",
    "--out",
  ]);
  const [document] = positional;
  if (!document || positional.length > 1) fail(2, USAGE);
  const kindValue = options.get("--kind");
  const kind = kindValue === undefined ? undefined : kindOption(kindValue);
  if (kindValue !== undefined && !kind)
    fail(2, `--kind must be requirements or architecture, not ${kindValue}`);
  const root = consumerRoot();
  const made = makePlan({
    root,
    document,
    kind,
    companion: options.get("--companion"),
    out: options.get("--out"),
    date: local(),
  });
  const summary = {
    document: made.display,
    kind: made.kind,
    kindFrom: made.kindFrom,
    directory: made.directory,
    ignoredByGit: await ignored(root, made.directory),
    report: made.report,
    personas: made.personas.map((p) => ({
      id: p.id,
      name: p.name,
      brief: p.brief,
      prompt: promptFor(p),
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

function persona(planned: Plan, id: string): PlannedPersona {
  const found = planned.personas.find((p) => p.id === id);
  if (!found)
    fail(
      2,
      `${id} is not a persona of this review; it has ${planned.personas.map((p) => p.id).join(", ")}`,
    );
  return found;
}

/** Check one persona's output and keep it, stamped with how it ran. */
function collectOne(
  planned: Plan,
  who: PlannedPersona,
  context: Context,
): string[] {
  const document = unchangedDocument(planned);
  const source = existsSync(who.output) ? who.output : who.reply;
  if (!existsSync(source))
    return [
      `nothing to collect: neither ${who.output} nor ${who.reply} exists`,
    ];
  // A replacement submission supersedes what was kept: if it fails its checks,
  // the old verdict must not stay behind to be reported.
  rmSync(who.findings, { force: true });
  rmSync(planned.report, { force: true });
  const value = extractJson(readFileSync(source, "utf8"));
  const { findings, problems } = checkFindings(
    value,
    who.id,
    document,
    context,
  );
  if (findings)
    writeFileSync(who.findings, `${JSON.stringify(findings, null, 2)}\n`);
  return problems;
}

function collect(args: string[]): number {
  const { positional, options } = parse(args, ["--context"]);
  const [directory, id] = positional;
  const context = options.get("--context");
  if (!directory || !id || positional.length > 2) fail(2, USAGE);
  if (!(CONTEXTS as readonly string[]).includes(context ?? ""))
    fail(2, `--context must be one of ${CONTEXTS.join(", ")}`);
  const planned = readPlan(directory);
  const problems = collectOne(
    planned,
    persona(planned, id),
    context as Context,
  );
  if (problems.length > 0) {
    console.error(`${id}: the findings were not collected:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(`${id}: collected`);
  return 0;
}

/** The longest delay a timer takes, in seconds (a signed 32-bit count of milliseconds). */
const MAX_TIMER_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

function wholeNumber(
  value: string | undefined,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < 1 || number > max)
    fail(
      2,
      `${name} must be a positive whole number${max < Number.MAX_SAFE_INTEGER ? ` of at most ${max}` : ""}`,
    );
  return number;
}

async function fresh(args: string[]): Promise<number> {
  const { positional, options, command } = parse(args, [
    "--timeout-seconds",
    "--parallel",
  ]);
  const [directory] = positional;
  if (!directory || positional.length > 1 || command.length === 0)
    fail(2, USAGE);
  const planned = readPlan(directory);
  unchangedDocument(planned);
  return runFresh(planned, command, {
    root: consumerRoot(),
    timeoutSec: wholeNumber(
      options.get("--timeout-seconds"),
      "--timeout-seconds",
      900,
      MAX_TIMER_SECONDS,
    ),
    parallel: wholeNumber(options.get("--parallel"), "--parallel", 4),
    collect: (who) => collectOne(planned, who, "fresh-run"),
  });
}

function report(args: string[]): number {
  const { positional } = parse(args, []);
  const [directory] = positional;
  if (!directory || positional.length > 1) fail(2, USAGE);
  const planned = readPlan(directory);
  const document = unchangedDocument(planned);
  const missing = planned.personas.filter((p) => !existsSync(p.findings));
  if (missing.length > 0) {
    console.error(
      `no report yet: these personas have no collected findings: ${missing.map((p) => p.id).join(", ")}`,
    );
    return 1;
  }
  const results: Findings[] = [];
  const problems: string[] = [];
  for (const p of planned.personas) {
    const kept = readKept(readFileSync(p.findings, "utf8"), p.id, document);
    if (kept.findings) results.push(kept.findings);
    for (const problem of kept.problems) problems.push(`${p.id}: ${problem}`);
  }
  if (problems.length > 0) {
    console.error("no report: these kept findings fail their checks:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  writeFileSync(planned.report, renderReport(planned, results));
  console.log(planned.report);
  return 0;
}

async function main(): Promise<number> {
  const [step, ...args] = process.argv.slice(2);
  try {
    if (step === "plan") return await plan(args);
    if (step === "collect") return collect(args);
    if (step === "fresh") return await fresh(args);
    if (step === "report") return report(args);
  } catch (error) {
    if (error instanceof PlanError) fail(error.code, error.message);
    throw error;
  }
  return fail(2, USAGE);
}

if (import.meta.main) runMain("red-team", main);
