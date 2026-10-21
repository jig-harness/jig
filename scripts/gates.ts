// Jig's gate set, stated once: the ordered stages `bun run gates` runs.
//
// Cheapest first. The always-loaded context budget, format, lint, types and
// the repository checks take seconds and run before the minutes the tests and
// build take, so a broken link is reported at the start of a run, not after
// the suite. `--fast` runs only those stages, for the pre-push hook
// (lefthook.yml); CI runs them all.
//
// Every stage reports. The stages are independent, so a failing one does not
// end the run: each remaining stage still runs, the run ends with the list of
// what failed (each line is the command that reruns it), and the exit status
// is 1 when any stage found violations and 2 when the only failures are
// stages that could not check (a stage that threw counts as could not check).
// Two unrelated failures surface in one run rather than two.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { couldNotCheck } from "../lib/findings.ts";
import { checkLinks } from "./check-md-links.ts";
import { checkInstructionPaths } from "./check-instruction-paths.ts";
import { checkTables } from "./check-md-tables.ts";
import { checkGlossary } from "./check-glossary-coverage.ts";
import { checkTracker } from "./check-no-tracker-refs.ts";
import { checkTrackerBoundary } from "./check-tracker-boundary.ts";
import { checkLicences } from "./check-licences.ts";
import { checkChangelog } from "./check-changelog.ts";
import { checkAuditFit } from "./check-audit-fit.ts";
import { checkChangeAreas } from "./change-areas.ts";
import { checkGeneratedFiles } from "./check-generated-files.ts";
import { checkWorkflowSafety } from "./check-workflow-safety.ts";
import { checkWorkflowConventions } from "./check-workflow-conventions.ts";
import { checkSchedulesDeclared } from "./check-schedules-declared.ts";
import { checkLifecycleMap } from "./check-lifecycle-map.ts";
import { checkReviewRisk } from "./review-risk.ts";
import { checkRoadmap } from "./check-roadmap.ts";
import { checkContextBudget } from "./check-context-budget.ts";
import { checkSupplyChainLockstep } from "./check-supply-chain-lockstep.ts";
import { checkPlugin } from "./check-plugin.ts";
const root = join(import.meta.dir, "..");

/**
 * Suites that need a POSIX system: the launcher's put a `/bin/sh` stub on
 * `PATH` and check file modes, so they cannot run on Windows, and the Herdr
 * workspace tool's serve a runtime that runs on macOS and Linux. Windows runs
 * every other suite; a test inside one that needs POSIX skips itself on win32
 * and names the work that lifts the skip.
 */
export const POSIX_ONLY_SUITES = ["tools/launcher/**", "tools/herdr/**"];

/**
 * Suites that run in their own CI job (`.github/workflows/gates.yml` and `nightly.yml`), which
 * sets this variable in the gate job so no suite runs twice. The drive-pr
 * suite takes about twelve minutes one file at a time, so CI splits it across
 * parallel jobs; the website's parser tests need the website's own
 * dependencies, which only the website job installs. Locally `bun run gates`
 * runs everything.
 */
export const SEPARATE_SUITES = ["plugin/skills/drive-pr/**", "website/**"];
export const SKIP_SEPARATE_ENV = "JIG_GATES_SKIP_SEPARATE_SUITES";

/** The suite patterns this platform and environment leave out of the test step. */
export function skippedSuites(
  platform: string,
  env: Record<string, string | undefined>,
): string[] {
  const skipped = new Set<string>();
  if (platform === "win32") for (const p of POSIX_ONLY_SUITES) skipped.add(p);
  if (env[SKIP_SEPARATE_ENV] === "1")
    for (const p of SEPARATE_SUITES) skipped.add(p);
  return [...skipped];
}

/**
 * The `bun run test` arguments. Bun's `--path-ignore-patterns` replaces the
 * `bunfig.toml` list rather than adding to it, so the configured patterns are
 * passed along with the skipped suites.
 */
export function testArgs(skipped: string[], configured: string[]): string[] {
  if (!skipped.length) return ["run", "test"];
  return [
    "run",
    "test",
    ...[...configured, ...skipped].map((p) => `--path-ignore-patterns=${p}`),
  ];
}

function configuredIgnores(): string[] {
  const bunfig = Bun.TOML.parse(
    readFileSync(join(root, "bunfig.toml"), "utf8"),
  ) as { test?: { pathIgnorePatterns?: string[] } };
  return bunfig.test?.pathIgnorePatterns ?? [];
}

/**
 * One stage of a run, named by the command that reruns it alone: either a
 * `bun <args>` command spawned with its output inherited, or a check function
 * called in this process with the repository root.
 */
export type Stage = { name: string } & (
  | { command: string[] }
  | { check: (root: string) => number | Promise<number> }
);

/**
 * An argument as a POSIX shell word: as it is when it holds no character a
 * shell treats specially, single-quoted otherwise, so a pasted stage name
 * passes a glob in an ignore pattern to bun unexpanded.
 */
export function shellWord(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** A `bun <args>` stage, named by the command, each argument a shell word. */
function command(...args: string[]): Stage {
  return { name: `bun ${args.map(shellWord).join(" ")}`, command: args };
}

/** A check-function stage, named by the script that runs the same check. */
function check(
  script: string,
  run: (root: string) => number | Promise<number>,
): Stage {
  return { name: `bun scripts/${script}`, check: run };
}

/** The repository checks: seconds each, so they run before the heavy stages. */
export const CHECKS: Stage[] = [
  // First, as in CI, where it runs before the install: a change that lets
  // a package run install scripts is judged before any script can run.
  check("check-supply-chain-lockstep.ts", checkSupplyChainLockstep),
  check("check-md-links.ts", checkLinks),
  check("check-instruction-paths.ts", checkInstructionPaths),
  check("check-md-tables.ts", checkTables),
  check("check-glossary-coverage.ts", checkGlossary),
  check("check-no-tracker-refs.ts", checkTracker),
  check("check-tracker-boundary.ts", checkTrackerBoundary),
  check("check-licences.ts", checkLicences),
  check("check-workflow-safety.ts", checkWorkflowSafety),
  check("check-workflow-conventions.ts", checkWorkflowConventions),
  check("check-schedules-declared.ts", checkSchedulesDeclared),
  check("check-lifecycle-map.ts", checkLifecycleMap),
  check("check-changelog.ts", checkChangelog),
  check("check-audit-fit.ts", checkAuditFit),
  check("change-areas.ts --check", checkChangeAreas),
  check("check-generated-files.ts", checkGeneratedFiles),
  check("review-risk.ts --check", checkReviewRisk),
  check("check-roadmap.ts", checkRoadmap),
  check("check-plugin.ts", checkPlugin),
];

/**
 * The test stage. The configured ignore patterns are read only when suites
 * are skipped, and a read that fails becomes this stage's could-not-check
 * when the stage runs, so it never stops the stages before or after it.
 */
export function testStage(skipped: string[], ignores: () => string[]): Stage {
  let configured: string[] = [];
  try {
    if (skipped.length) configured = ignores();
  } catch (error: unknown) {
    return {
      name: command("run", "test").name,
      check: () => {
        throw error;
      },
    };
  }
  return command(...testArgs(skipped, configured));
}

/** The stages `--fast` leaves out: the ones that take minutes. */
export function heavyStages(test: Stage): Stage[] {
  return [
    command("run", "deadcode"),
    command("run", "audit"),
    command("run", "quality"),
    test,
    command("run", "build"),
  ];
}

/**
 * What a run executes, in order: the stages that take seconds (the context
 * budget first, as in CI, where it runs before dependencies are installed;
 * then format, lint, types and the repository checks), and in a full run the
 * heavy stages after them.
 */
export function plan(fast: boolean, test: Stage): Stage[] {
  const quick: Stage[] = [
    check("check-context-budget.ts", checkContextBudget),
    command("run", "format:check"),
    command("run", "lint"),
    command("run", "typecheck"),
    command("run", "pins"),
    ...CHECKS,
  ];
  return fast ? quick : [...quick, ...heavyStages(test)];
}

/** What one stage of a run reported. */
export interface Outcome {
  name: string;
  status: number;
}

/** One stage's status: a command's exit code, or a check's return value. */
async function runStage(stage: Stage, root: string): Promise<number> {
  if (!("command" in stage)) return stage.check(root);
  const child = Bun.spawn([process.execPath, ...stage.command], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

/**
 * Run every stage in order, whatever the earlier ones reported, and return
 * each stage's status. A stage that throws (a check that cannot read its
 * input, a command that cannot be started) could not check (2), with the
 * error reported as the shared helper reports one.
 */
export async function runStages(
  stages: Stage[],
  root: string,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const stage of stages) {
    let status: number;
    try {
      status = await runStage(stage, root);
    } catch (error: unknown) {
      status = couldNotCheck(
        stage.name,
        error instanceof Error ? error.message : String(error),
      );
    }
    outcomes.push({ name: stage.name, status });
  }
  return outcomes;
}

/**
 * The run's exit status: 1 when any stage found violations, otherwise 2 when
 * any stage could not check (or exited with another status), otherwise 0. A
 * run in which no stage ran could not check: it is not evidence of a pass.
 */
export function verdict(outcomes: Outcome[]): number {
  if (!outcomes.length) return 2;
  if (outcomes.some((o) => o.status === 1)) return 1;
  if (outcomes.some((o) => o.status !== 0)) return 2;
  return 0;
}

/**
 * The closing report: the pass line, or how many stages failed and, one per
 * line, the command that reruns each, its status after it as a shell comment
 * so the line pasted whole still runs the command.
 */
export function summary(outcomes: Outcome[], fast: boolean): string {
  if (!outcomes.length) return "gates: could not check: no stage ran";
  const failed = outcomes.filter((o) => o.status !== 0);
  if (!failed.length) return fast ? "fast gates passed" : "all gates passed";
  return [
    `gates: ${failed.length} of ${outcomes.length} stages failed`,
    ...failed.map((o) => `  ${o.name}  # exit ${o.status}`),
  ].join("\n");
}

async function gates(fast: boolean): Promise<number> {
  const skipped = fast ? [] : skippedSuites(process.platform, process.env);
  if (skipped.length)
    console.log(`test step skips (see scripts/gates.ts): ${skipped.join(" ")}`);
  const outcomes = await runStages(
    plan(fast, testStage(skipped, configuredIgnores)),
    root,
  );
  const status = verdict(outcomes);
  (status ? console.error : console.log)(summary(outcomes, fast));
  return status;
}
if (import.meta.main) cli(() => gates(process.argv.includes("--fast")));
