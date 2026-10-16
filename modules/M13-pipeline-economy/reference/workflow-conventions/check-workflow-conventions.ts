// Workflow-convention lint (M13 Pipeline economy): the pipeline-efficiency
// conventions, checked over the parsed GitHub Actions workflows and composite
// actions instead of left to prose, where they regress silently.
//
// Rules (README.md says why each exists): job-timeout, pr-concurrency,
// required-not-path-filtered, aggregator-unless-cancelled, ci-hold-guard,
// ci-hold-events and ci-hold-sentinel, heavy-per-change, cache-env-parity,
// pinned-uses, push-pr-paths, catalog-paths. Every exception carries a
// reason, and one that suppresses no finding is itself a finding
// (exception-list).
//
// Exit 0: every convention holds. Exit 1: findings, each with its rule,
// file:line, problem and fix. Exit 2: could not check: a folder that cannot be
// read, a file that is not valid YAML (a repeated key included), a
// configuration or exception list that is malformed, a folder named on the
// command line that does not exist, or no workflow and no action to read.
//
// Usage:
//   bun check-workflow-conventions.ts [--root <dir>] [--workflows <dir>]
//     [--actions <dir>] [--jig-config <file>] [--config <file>]
//     [--exceptions <file>]
// Defaults, relative to --root (default "."): .github/workflows,
// .github/actions, .config/jig.yaml, .config/workflow-conventions.yaml,
// .config/workflow-conventions-exceptions.txt. A default file or folder that
// does not exist is read as empty; one named on the command line must exist.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cli } from "../../../../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../../../../lib/findings.ts";
import {
  type ExceptionEntry,
  readExceptions,
  readPipelines,
  readSettings,
  Unreadable,
} from "./inputs.ts";
import {
  aggregatorUnlessCancelled,
  cacheEnvParity,
  catalogPaths,
  ciHold,
  type Found,
  heavyPerChange,
  jobTimeout,
  type Pipelines,
  pinnedUses,
  prConcurrency,
  pushPrPaths,
  requiredJobs,
  requiredNotPathFiltered,
} from "./rules.ts";

const GATE = "workflow-conventions";
const EXCEPTION_RULE = "exception-list";

const RULES: Record<string, (p: Pipelines) => Found[]> = {
  "job-timeout": jobTimeout,
  "pr-concurrency": prConcurrency,
  "required-not-path-filtered": requiredNotPathFiltered,
  "aggregator-unless-cancelled": aggregatorUnlessCancelled,
  "ci-hold": ciHold,
  "heavy-per-change": heavyPerChange,
  "cache-env-parity": cacheEnvParity,
  "pinned-uses": pinnedUses,
  "push-pr-paths": pushPrPaths,
  "catalog-paths": catalogPaths,
};
/** The rule names a finding, and so an exception, can carry. */
const RULE_NAMES = [
  ...Object.keys(RULES).filter((rule) => rule !== "ci-hold"),
  "ci-hold-guard",
  "ci-hold-events",
  "ci-hold-sentinel",
];

export interface Options {
  root?: string | undefined;
  workflows?: string | undefined;
  actions?: string | undefined;
  jigConfig?: string | undefined;
  config?: string | undefined;
  exceptions?: string | undefined;
  /** A repository that always has workflows: none found could not check,
   * whatever actions it has. */
  requireWorkflows?: boolean | undefined;
}

/** Drop the findings an exception covers: every finding of its rule in its
 * file, or in its job when it names one. The first matching entry takes
 * each finding, so a repeated entry covers nothing. Report exceptions
 * without a reason, and exceptions that cover nothing. */
function applyExceptions(
  findings: Found[],
  entries: ExceptionEntry[],
  list: string,
): Finding[] {
  const used = new Set<ExceptionEntry>();
  const kept = findings.filter((finding) => {
    const entry = entries.find(
      (e) =>
        e.reason &&
        e.rule === finding.rule &&
        e.file === finding.file &&
        (e.job === undefined || e.job === finding.job),
    );
    if (entry) used.add(entry);
    return !entry;
  });
  const listFindings = entries
    .filter((e) => !used.has(e))
    .map(
      (e): Finding => ({
        rule: EXCEPTION_RULE,
        file: list,
        line: e.line,
        problem: e.reason
          ? `exception '${e.rule} ${e.file}${e.job ? ` ${e.job}` : ""}' suppresses no finding`
          : `exception '${e.rule} ${e.file}${e.job ? ` ${e.job}` : ""}' has no reason`,
        remedy: e.reason
          ? "delete the entry"
          : "put the entry under a `#` comment that says why the rule does not fit",
      }),
    );
  return [...kept, ...listFindings];
}

/** One line per rule that needs configuration and has none, so a pass says
 * what it did not check. */
function notes(p: Pipelines): string[] {
  const s = p.settings;
  const required = p.workflows.flatMap((wf) =>
    requiredJobs(wf, s).map((job) => `${wf.name}#${job.id}`),
  );
  return [
    `required checks: ${required.length ? required.join(", ") : "none found"} (${s.requiredChecks ? "from ci.required_checks" : "derived: aggregator jobs"})`,
    s.holdLabel
      ? `CI hold: label '${s.holdLabel}'`
      : "CI hold: not configured (ci.hold_label unset), ci-hold rules not applicable",
    `heavy suites: ${s.heavy.length || "none declared"}`,
    s.cacheGroups.length
      ? `cache groups: ${s.cacheGroups.length}`
      : "cache groups: none configured, cache-env-parity not applicable",
    s.catalog
      ? "change-area catalog: configured"
      : "change-area catalog: not configured, catalog-paths not applicable",
  ];
}

/** Run the lint; returns the exit status. */
export function lintWorkflowConventions(
  options: Options = {},
  env: Record<string, string | undefined> = process.env,
): number {
  const root = resolve(options.root ?? ".");
  const at = (given: string | undefined, fallback: string) =>
    given ? resolve(given) : join(root, fallback);
  const exceptions = at(
    options.exceptions,
    ".config/workflow-conventions-exceptions.txt",
  );
  let pipelines: Pipelines;
  let entries: ExceptionEntry[];
  try {
    const { workflows, actions } = readPipelines(root, {
      workflows: at(options.workflows, ".github/workflows"),
      actions: at(options.actions, ".github/actions"),
      named: {
        workflows: options.workflows !== undefined,
        actions: options.actions !== undefined,
      },
    });
    if (!workflows.length && (options.requireWorkflows || !actions.length))
      return couldNotCheck(
        GATE,
        options.requireWorkflows
          ? "no workflow found"
          : "no workflow and no composite action found",
        env,
      );
    const settings = readSettings(root, {
      jigConfig: at(options.jigConfig, ".config/jig.yaml"),
      config: at(options.config, ".config/workflow-conventions.yaml"),
      named: {
        jigConfig: options.jigConfig !== undefined,
        config: options.config !== undefined,
      },
    });
    pipelines = { workflows, actions, settings };
    entries = readExceptions(
      exceptions,
      options.exceptions !== undefined,
      root,
      RULE_NAMES,
    );
  } catch (e) {
    if (e instanceof Unreadable) return couldNotCheck(GATE, e.message, env);
    throw e;
  }
  const found = Object.values(RULES).flatMap((rule) => rule(pipelines));
  const findings = applyExceptions(found, entries, repoPath(root, exceptions));
  const summary = `${pipelines.workflows.length} workflow(s), ${pipelines.actions.length} composite action(s), ${entries.length} exception(s)`;
  for (const note of notes(pipelines)) console.log(`${GATE}: ${note}`);
  if (findings.length) {
    reportFindings(findings, env);
    console.error(`${GATE}: ${findings.length} finding(s) in ${summary}`);
    return 1;
  }
  console.log(`${GATE}: OK — ${summary}; every convention holds`);
  return 0;
}

if (import.meta.main)
  cli(() => {
    const { values } = parseArgs({
      options: {
        root: { type: "string" },
        workflows: { type: "string" },
        actions: { type: "string" },
        "jig-config": { type: "string" },
        config: { type: "string" },
        exceptions: { type: "string" },
      },
    });
    return lintWorkflowConventions({
      ...values,
      jigConfig: values["jig-config"],
    });
  });
