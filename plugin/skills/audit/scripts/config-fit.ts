#!/usr/bin/env bun
/**
 * How well the repository's `.config/jig.yaml` fits the repository and this
 * plugin version. Reports, each with a stable id:
 *
 *   - fields the schema does not know, refuses, or reads only under an older
 *     name, and values of the wrong shape (`config-schema.yaml`);
 *   - what the skills' own validation rejects;
 *   - derivations that fail: a command whose program or script does not
 *     exist, a configured path that is missing, an integration branch that
 *     cannot be found, a required check that never runs, an unreachable tracker;
 *   - declared values the repository contradicts, such as `stacking: none`
 *     with stacked pull requests open, or an AI reviewer named that posted on
 *     no recent pull request (or one that ran while none is named);
 *   - the checkout itself: HEAD behind the integration branch, an origin/HEAD
 *     that names another branch than the forge's default, `.context/` not
 *     ignored, and what the former `groundwork` plugin left behind (its
 *     overlay file, its names in instructions and settings, its fields);
 *   - a slash command in `issue_tracker.file_command` that resolves nowhere,
 *     commands CI runs that the gate command does not appear to (a
 *     heuristic), and a gate program the Claude Code settings do not allow;
 *   - configured tracker labels that the repository's label taxonomy
 *     (`issue_tracker.taxonomy`, else `label-taxonomy.yaml`) does not
 *     define, and a `review.taxonomy.types` that differs from its types;
 *   - settings the repository's shape suggests but does not use;
 *   - the facts a profile suggestion rests on (`lib/profile-facts.ts`):
 *     contributors, deploy signals in CI and in tracked deploy
 *     configuration, compliance documents, the lightest profile they
 *     support, and another profile to consider beside it or beside the one
 *     the audit record declares.
 *
 * The values the repository implies come from the shared detector
 * (`shared/detect.ts`), each with the fact it was read from; this script
 * offers the ones the file leaves unset (`lib/suggestions.ts`), and together
 * they make a starter configuration (the detector's `draftConfig`): a whole
 * file for a repository without one, the fields to add for a repository with
 * one.
 *
 * Read-only: it runs `git` and, unless `--offline`, read-only `gh` calls and
 * one tracker read. A question it cannot answer is reported as unchecked,
 * never as a pass. It never writes the configuration; the starter is printed.
 *
 * Usage (from anywhere inside the repository under audit):
 *   bun config-fit.ts [--offline] [--json | --draft] [--record <path>]
 *
 *   --json   the whole report, the starter configuration included (`draft`)
 *   --draft  only the starter configuration, or a line saying there is
 *            nothing to suggest; exits 0 whatever the findings
 *
 * A finding the audit record declines (`config/<id>` in its `declined` refs)
 * is listed as declined instead of reported again, until its revisit date.
 * An error is reported whatever the record says: a decline records a
 * preference, and the skills refuse the file regardless.
 *
 * Exit codes: 0 no errors; 1 at least one error; 2 usage or an unreadable
 * configuration file.
 */
import {
  sizePointsFindings,
  skillValidation,
} from "./lib/section-validation.ts";
import {
  ENV_PREFIX,
  isMapping as isRecord,
  readConfigFile,
  userConfigPath,
  userLayerEnabled,
} from "../../../shared/config-layers.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import {
  consumerRoot,
  layeredConfig,
  OVERLAY_RELPATH,
  overlayPath,
  reviewerSelection,
} from "../../../shared/consumer.ts";
import { parseTrackerConfig } from "../../do-item/scripts/lib/tracker/config.ts";
import { openTracker } from "../../do-item/scripts/lib/tracker/index.ts";
import { trackerProbeable } from "./lib/tracker-probe.ts";
import { swallow } from "../../../shared/errors.ts";
import { ghCall } from "../../../shared/proc.ts";
import { type AuditRecord, parseRecord, RECORD_RELPATH } from "./lib/record.ts";
import { taxonomyFindings } from "./lib/taxonomy-fit.ts";
import {
  configuredAt,
  trackedNeeds,
  newerInstalledVersion,
  onDisk,
  pluginVersion,
  skillDir,
  today,
  trackedFiles,
} from "./lib/repo.ts";
import {
  ASSIGNMENT,
  type CiJob,
  ciJobs,
  commandSegments,
  commandWords,
  draftConfig,
  type ForgeRepo,
  forgeRepo,
  gateCommand,
  ghJson,
  issueKeySources,
  makefileOf,
  mergedPulls,
  normalLogin,
  OPEN_PULL_LIMIT,
  type OpenPull,
  openPulls,
  originHead,
  packageScripts,
  type Pull,
  reviewBots,
  reviewerCounts,
  run,
  scan,
  stackedPulls,
  texts,
  withoutAssignments,
} from "../../../shared/detect.ts";
import {
  catalogSuggestion,
  repoSlugSuggestion,
  stackingSuggestion,
  type Suggestion,
  suggest,
  suggestedFacts,
  suggestionId,
  trackerTeamSuggestion,
} from "./lib/suggestions.ts";
import {
  type ProfileFacts,
  profileFactLines,
  profileFacts,
} from "./lib/profile-facts.ts";
import {
  at,
  checkConfig,
  type Field,
  type Finding,
  loadSchema,
  type Schema,
} from "./lib/schema.ts";

export interface FitReport {
  file: string;
  configured: boolean;
  forge: "checked" | "unchecked" | "offline";
  facts: Record<string, string>;
  /** What a profile suggestion rests on, and the suggestion; also summarised in `facts`. */
  profile_facts?: ProfileFacts;
  findings: Finding[];
  declined: { finding: Finding; reason: string; revisit_when: string }[];
  /** The values the repository implies, each behind a `suggestion:` finding. */
  suggestions: Suggestion[];
  /** A starter configuration, or its additions, when anything is suggested. */
  draft?: string;
}

type Config = Record<string, unknown>;

const BUILTINS = new Set([
  "echo",
  "test",
  "[",
  "true",
  "false",
  "exit",
  "export",
  "set",
  "printf",
  ":",
]);
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);

/**
 * Each runner's own commands. Any other first word is a package script for
 * `bun`, `pnpm` and `yarn`; for `npm` only `test` is.
 */
const RUNNER_COMMANDS: Record<string, Set<string>> = {
  bun: new Set(
    "run test x exec repl install i add a remove rm update outdated link unlink pm build init create c upgrade publish patch audit info why".split(
      " ",
    ),
  ),
  pnpm: new Set(
    "add install i update up remove rm link unlink import rebuild prune fetch patch patch-commit audit list ls outdated why licenses run exec dlx create publish pack store root bin setup init deploy doctor config env server".split(
      " ",
    ),
  ),
  yarn: new Set(
    "add audit autoclean bin cache config create dlx exec explain info init install link list node npm outdated pack patch plugin rebuild remove run set unlink unplug up upgrade upgrade-interactive version why workspace workspaces constraints dedupe import licenses login logout owner publish tag team global help policies check".split(
      " ",
    ),
  ),
};
const NPM_SCRIPT_ALIASES = new Set(["test", "t", "tst"]);

/** Flags that make a runner or make read another directory or file. */
const ELSEWHERE = new Set([
  "--filter",
  "-F",
  "-w",
  "--workspace",
  "--prefix",
  "--cwd",
  "--dir",
  "-C",
  "-f",
  "--file",
  "--makefile",
]);

/** Flags whose next word is their value, not a script or target. */
const VALUE_FLAGS = new Set([...ELSEWHERE, "-j", "--jobs"]);

/** The words of a command that are neither flags nor a flag's value. */
function operandsOf(args: string[]): string[] {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) operands.push(arg);
    else if (VALUE_FLAGS.has(arg)) i++;
  }
  return operands;
}

/** The targets a makefile defines, including several on one rule line. */
function makeTargets(text: string): Set<string> {
  const targets = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const rule = /^([^\s#:=][^:=]*?)\s*::?(?!=)/.exec(line);
    if (rule) for (const name of rule[1]?.split(/\s+/) ?? []) targets.add(name);
  }
  return targets;
}

const SCRIPT_FILE = /\.(m?[jt]s|cjs|tsx|jsx)$/;

type Problem = { severity: "error" | "warning" | "info"; message: string };

/** What the checks of one command line read from the repository. */
interface Context {
  root: string;
  scripts: Record<string, string> | null;
  tracked: Set<string>;
}

/**
 * What is wrong with a file a command names: missing, not a file, not
 * tracked (a fresh clone lacks it), or, run directly on POSIX, not executable.
 */
function fileProblems(name: string, ctx: Context, direct: boolean): Problem[] {
  const path = onDisk(ctx.root, name);
  if (!existsSync(path))
    return [{ severity: "error", message: `${name} does not exist` }];
  const stat = statSync(path);
  if (!stat.isFile())
    return [{ severity: "error", message: `${name} is not a file` }];
  if (direct && process.platform !== "win32" && (stat.mode & 0o111) === 0)
    return [{ severity: "error", message: `${name} is not executable` }];
  if (isAbsolute(name)) return [];
  const { untracked, unsure } = trackedNeeds(ctx.root, name, ctx.tracked);
  const which = untracked.map((reached) => reached.join(" or ")).join(", ");
  const messages = unsure.map(
    ({ reached, held }) =>
      `${name} reaches one of ${reached.join(" or ")}, the same file, and only ${held.join(" or ")} is tracked; which name the lookup took cannot be told, so a fresh clone may lack it`,
  );
  if (untracked.length > 0)
    messages.unshift(
      which === normalize(name).replaceAll("\\", "/")
        ? `${name} is not tracked, so a fresh clone lacks it`
        : `${name} reaches ${which}, which is not tracked, so a fresh clone lacks it`,
    );
  return messages.map((message) => ({ severity: "warning", message }));
}

/** What a missing package script costs: `target` is the script's name. */
function scriptProblems(target: string, ctx: Context): Problem[] {
  if (ctx.scripts === null)
    return [
      {
        severity: "error",
        message: `there is no package.json to define "${target}"`,
      },
    ];
  return Object.hasOwn(ctx.scripts, target)
    ? []
    : [
        {
          severity: "error",
          message: `package.json has no "${target}" script`,
        },
      ];
}

/** A first word that is not `run`, a script or a file: a runner command, or unknown. */
function bareRunnerProblems(
  program: string,
  target: string,
  ctx: Context,
): Problem[] {
  if (program === "npm")
    return NPM_SCRIPT_ALIASES.has(target) ? scriptProblems("test", ctx) : [];
  if (RUNNER_COMMANDS[program]?.has(target)) return [];
  return [
    {
      severity: "warning",
      message: `"${target}" is neither a package.json script nor a ${program} command this audit knows`,
    },
  ];
}

/** Whether `package.json` defines `target` as a script. */
function isScript(target: string, ctx: Context): boolean {
  return ctx.scripts !== null && Object.hasOwn(ctx.scripts, target);
}

/**
 * Whether a runner reads `target` as a file: a script defines no such name,
 * and only `bun` runs a file through `run` (npm, pnpm and yarn `run` name a
 * script).
 */
function runsFile(program: string, viaRun: boolean, target: string): boolean {
  return (
    (program === "bun" || !viaRun) &&
    (SCRIPT_FILE.test(target) || target.includes("/"))
  );
}

/** What a package runner (`bun`, `npm`, …) would fail to find here. */
function runnerProblems(
  program: string,
  operands: string[],
  ctx: Context,
): Problem[] {
  const viaRun = operands[0] === "run";
  const target = viaRun ? operands[1] : operands[0];
  if (target === undefined || isScript(target, ctx)) return [];
  if (runsFile(program, viaRun, target))
    return fileProblems(target, ctx, false);
  return viaRun
    ? scriptProblems(target, ctx)
    : bareRunnerProblems(program, target, ctx);
}

/** What `make` would fail to find here: every target operand must exist. */
function makeProblems(operands: string[], root: string): Problem[] {
  const targets = operands.filter((o) => !ASSIGNMENT.test(o));
  if (targets.length === 0) return [];
  const makefile = makefileOf(root);
  if (makefile === undefined)
    return [{ severity: "error", message: "there is no Makefile" }];
  const text = readFileSync(join(root, makefile), "utf8");
  const defined = makeTargets(text);
  // An included makefile may define it; only then is it a guess.
  const severity = /^-?include\s/m.test(text) ? "warning" : "error";
  return targets
    .filter((t) => !defined.has(t))
    .map((t) => ({ severity, message: `${makefile} has no "${t}" target` }));
}

/** Why one segment of a command line would not run here. */
function segmentProblems(segment: string[], ctx: Context): Problem[] {
  const words = commandWords(segment);
  if (typeof words !== "string") return programProblems(words, ctx);
  return [
    {
      severity: "info",
      message: `runs its command through \`${words}\`, so that command is unchecked`,
    },
  ];
}

/** Why the program and arguments of one segment would not run here. */
function programProblems(words: string[], ctx: Context): Problem[] {
  const [program, ...args] = words;
  if (program === undefined || BUILTINS.has(program)) return [];
  if (program.includes("/")) return fileProblems(program, ctx, true);
  const problems: Problem[] = [];
  if (!Bun.which(program))
    problems.push({
      severity: "warning",
      message: `${program} is not installed on this machine`,
    });
  if (!RUNNERS.has(program) && program !== "make") return problems;
  const elsewhere = args.find((a) => ELSEWHERE.has(a.split("=")[0] ?? ""));
  if (elsewhere !== undefined) {
    problems.push({
      severity: "info",
      message: `reads another directory or file (${elsewhere}), so whether its script or target exists is unchecked`,
    });
    return problems;
  }
  const operands = operandsOf(args);
  problems.push(
    ...(program === "make"
      ? makeProblems(operands, ctx.root)
      : runnerProblems(program, operands, ctx)),
  );
  return problems;
}

/**
 * Why a configured command would not run here: a placeholder left in, a
 * command line a shell refuses, a program or script file that does not exist
 * or cannot run, or a package script or make target the repository does not
 * define. A program missing from this machine's PATH is a warning only: CI or
 * a teammate may have it. What runs after a `cd` is reported unchecked, and so
 * is a whole line using shell syntax beyond plain words, quotes and `&&`,
 * `||`, `;` and `|`: checking a guess at what it runs would pass broken
 * commands and refuse working ones. A line a shell refuses is an error even
 * then, unless its syntax changes how quotes are read.
 */
export function commandProblems(command: string, root: string): Problem[] {
  if (/<[A-Za-z][^<>]*>/.test(command))
    return [{ severity: "error", message: "still holds a placeholder (<…>)" }];
  const { segments, syntax, unsupported, requoted } = scan(command);
  if (syntax !== null && !requoted)
    return [{ severity: "error", message: syntax }];
  if (unsupported !== null)
    return [
      {
        severity: "info",
        message: `uses shell syntax this audit does not parse (${unsupported}), so it is unchecked`,
      },
    ];
  if (syntax !== null) return [{ severity: "error", message: syntax }];
  const ctx: Context = {
    root,
    scripts: packageScripts(root),
    tracked: new Set(trackedFiles(root)),
  };
  const problems: Problem[] = [];
  for (const [i, segment] of segments.entries()) {
    const words = commandWords(segment);
    if (typeof words !== "string" && words[0] === "cd") {
      if (i < segments.length - 1)
        problems.push({
          severity: "info",
          message: `changes directory (${segment.join(" ")}), so what runs after it is unchecked`,
        });
      break;
    }
    problems.push(...segmentProblems(segment, ctx));
  }
  return problems;
}

/** A configured command's problems, as findings at its path. */
function commandFindings(
  path: string,
  value: unknown,
  root: string,
): Finding[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return commandProblems(value, root).map((p) => ({
    id: `derivation:${path}`,
    severity: p.severity,
    message: `${path}: \`${value}\` ${p.message}`,
  }));
}

/** A configured path that does not exist, when the field expects it to. */
function pathFindings(field: Field, value: unknown, root: string): Finding[] {
  if (typeof value !== "string" || value.trim() === "" || !field.exists)
    return [];
  if (value.startsWith("~")) return [];
  if (existsSync(configuredAt(root, value))) return [];
  const required = field.exists === "required";
  return [
    {
      id: `derivation:${field.path}`,
      severity: required ? "error" : "warning",
      message: `${field.path}: ${value} does not exist${
        required ? `; ${field.read_by.join(", ")} refuse(s) to run` : ""
      }`,
    },
  ];
}

/** The derivation findings of one entry of a list field. */
function listEntryFindings(
  field: Field,
  entry: unknown,
  i: number,
  root: string,
): Finding[] {
  if (field.items === "command")
    return commandFindings(`${field.path}[${i}]`, entry, root);
  if (field.items === "path")
    return pathFindings(
      { ...field, exists: field.exists ?? "expected" },
      entry,
      root,
    );
  if (
    typeof field.items === "object" &&
    "fields" in field.items &&
    field.items.fields.command === "command" &&
    isRecord(entry)
  )
    return commandFindings(`${field.path}[${i}].command`, entry.command, root);
  return [];
}

/** The derivation findings of one configured field. */
function fieldFindings(field: Field, value: unknown, root: string): Finding[] {
  if (field.type === "command") return commandFindings(field.path, value, root);
  if (field.type === "path") return pathFindings(field, value, root);
  if (field.type === "list" && Array.isArray(value))
    return value.flatMap((entry, i) =>
      listEntryFindings(field, entry, i, root),
    );
  return [];
}

function derivations(config: Config, schema: Schema, root: string): Finding[] {
  return schema.fields.flatMap((field) => {
    const value = at(config, field.path);
    return value === undefined || value === null
      ? []
      : fieldFindings(field, value, root);
  });
}

/** Rules that tie two fields together, which a per-field check cannot see. */
function crossFieldRules(config: Config): Finding[] {
  const findings: Finding[] = [];
  const hold = at(config, "ci.hold_label");
  const ciChecks = at(config, "ci.required_checks");
  if (
    typeof hold === "string" &&
    !(Array.isArray(ciChecks) && ciChecks.length > 0)
  )
    findings.push({
      id: "rule:ci.hold_label",
      severity: "error",
      message:
        "ci.hold_label needs a nonempty ci.required_checks: the drive certifies a held head only against declared checks",
    });
  const pattern = at(config, "review.job_pattern");
  const reviewChecks = at(config, "review.required_checks");
  if (typeof pattern === "string" && pattern !== "") {
    try {
      reviewerSelection(pattern, texts(reviewChecks));
    } catch (e) {
      findings.push({
        id: "rule:review.job_pattern",
        severity: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const repoLabel = at(config, "review.repo_label");
  const repos = at(config, "review.taxonomy.repos");
  if (
    typeof repoLabel === "string" &&
    Array.isArray(repos) &&
    !repos.includes(repoLabel)
  )
    findings.push({
      id: "rule:review.repo_label",
      severity: "error",
      message: `review.repo_label ${repoLabel} is not one of review.taxonomy.repos`,
    });
  findings.push(...sizePointsFindings(config));
  findings.push(...workBatchSizesFindings(config));
  return findings;
}

/**
 * A `work_batch` section without `sizes`: work-batch then knows only the
 * batchable sizes and `review.taxonomy.sizes`, so a larger size label the
 * repository never lists is not recognised beside a batchable one.
 */
function workBatchSizesFindings(config: Config): Finding[] {
  if (at(config, "work_batch") === undefined) return [];
  // A null `sizes` reads as unset, so it leaves the same gap.
  if (at(config, "work_batch.sizes") != null) return [];
  return [
    {
      id: "rule:work_batch.sizes",
      severity: "warning",
      message:
        "work_batch is configured without work_batch.sizes: list every size label, batchable or not, or an issue carrying a batchable size beside an unlisted larger one is batched, and no labelling gaps are reported",
    },
  ];
}

/** A newer plugin installed than this session runs: the audit would judge with old criteria. */
function staleSession(): Finding[] {
  const newer = newerInstalledVersion();
  if (newer === null) return [];
  return [
    {
      id: "fact:newer-plugin-installed",
      severity: "warning",
      message: `this session runs plugin ${pluginVersion()}, but ${newer} is installed: a session keeps the version it started with, so start a new session to audit with ${newer}`,
    },
  ];
}

/** The dotted paths of every value set in `config`. */
function leafFields(config: Config, prefix = ""): string[] {
  return Object.entries(config).flatMap(([key, value]) =>
    isRecord(value)
      ? leafFields(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

/**
 * What the configuration layers of the machine running the audit add: the
 * audit judges the repository's file alone, but the skills on this machine,
 * and `trackerCheck`, also read the user file and the environment.
 */
function machineLayers(config: Config, schema: Schema): Finding[] {
  const findings: Finding[] = [];
  const path = userConfigPath();
  let user: Config | null = null;
  try {
    user = userLayerEnabled() ? readConfigFile(path) : null;
  } catch (error) {
    findings.push({
      id: "fact:user-layer-unreadable",
      severity: "warning",
      message: `this machine's user file cannot be read, so every skill here refuses to run: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const refused = schema.fields
    .filter((f) => f.repository_only && user && at(user, f.path) !== undefined)
    .map((f) => f.path);
  if (refused.length > 0)
    findings.push({
      id: "fact:user-layer-refused",
      severity: "warning",
      message: `this machine's ${path} sets ${refused.join(", ")}, which describe one repository: every skill here refuses the file until they move to the repository's file`,
    });
  const repository = new Set(leafFields(config));
  const filled = user ? leafFields(user).filter((f) => !repository.has(f)) : [];
  if (filled.length > 0)
    findings.push({
      id: "fact:user-layer",
      severity: "info",
      message: `on this machine ${path} sets ${filled.join(", ")}, which the repository's file leaves unset: the skills here use those values, others get the defaults. The audit judged the repository's file alone, except for the tracker check, which reads the configuration as the skills here do`,
    });
  const variables = Object.keys(process.env).filter((k) =>
    k.startsWith(ENV_PREFIX),
  );
  if (variables.length > 0)
    findings.push({
      id: "fact:environment-layer",
      severity: "info",
      message: `${variables.join(", ")} set values for this run only; the audit ignored them, except for the tracker check, which reads the configuration as the skills here do`,
    });
  return findings;
}

/** What classic branch protection says about a branch. */
type Classic = "protected" | "unprotected" | "unknown";

/**
 * Add the checks classic branch protection requires to `required`, and say
 * whether the branch has classic protection at all; unknown when that could
 * not be read.
 */
async function classicProtection(
  slug: string,
  base: string,
  root: string,
  required: Set<string>,
  report: FitReport,
): Promise<Classic> {
  const protection = await ghCall(
    ["api", `repos/${slug}/branches/${base}/protection`],
    { cwd: root },
  );
  if (protection.code !== 0) {
    if (/not protected/i.test(protection.stderr)) return "unprotected";
    // Reading protection needs admin rights; the branch itself tells any
    // reader whether it is protected at all.
    const branch = await ghJson(
      ["api", `repos/${slug}/branches/${base}`],
      root,
    );
    return branch.ok &&
      (branch.value as { protected?: unknown }).protected === false
      ? "unprotected"
      : "unknown";
  }
  let p: unknown;
  try {
    p = JSON.parse(protection.stdout);
  } catch (error) {
    report.facts.branch_protection_error = String(error);
    return "unknown";
  }
  if (!isRecord(p)) return "unknown";
  for (const check of protectionChecks(p.required_status_checks))
    required.add(check);
  const reviews = isRecord(p.required_pull_request_reviews)
    ? p.required_pull_request_reviews.required_approving_review_count
    : undefined;
  report.facts.required_reviews = String(
    typeof reviews === "number" ? reviews : 0,
  );
  return "protected";
}

/** The check names a protection's `required_status_checks` lists, old and new form. */
function protectionChecks(status: unknown): string[] {
  if (!isRecord(status)) return [];
  const contexts = Array.isArray(status.contexts) ? status.contexts : [];
  const checks = Array.isArray(status.checks) ? status.checks : [];
  return [
    ...contexts.filter((c): c is string => typeof c === "string"),
    ...checks
      .map((c) => (isRecord(c) ? c.context : undefined))
      .filter((c): c is string => typeof c === "string"),
  ];
}

/**
 * Add the checks the branch's rulesets require to `required`, and return how
 * many ruleset rules apply to the branch; null when the rulesets could not be
 * read.
 */
async function rulesetChecks(
  slug: string,
  base: string,
  root: string,
  required: Set<string>,
): Promise<number | null> {
  const rules = await ghJson(
    ["api", `repos/${slug}/rules/branches/${base}`],
    root,
  );
  if (!rules.ok || !Array.isArray(rules.value)) return null;
  for (const rule of rules.value as {
    type?: string;
    parameters?: { required_status_checks?: { context: string }[] };
  }[])
    if (rule.type === "required_status_checks")
      for (const c of rule.parameters?.required_status_checks ?? [])
        required.add(c.context);
  return rules.value.length;
}

/**
 * The checks the integration branch requires: classic protection and
 * rulesets both count. A branch with neither is reported as unprotected,
 * apart from one protected without a required check.
 */
async function requiredChecks(
  slug: string,
  base: string,
  root: string,
  report: FitReport,
): Promise<{ required: Set<string>; findings: Finding[] }> {
  const required = new Set<string>();
  const classic = await classicProtection(slug, base, root, required, report);
  const rules = await rulesetChecks(slug, base, root, required);
  if (classic === "unknown" || rules === null) {
    report.facts.branch_protection =
      "unchecked: protection or rulesets could not be read";
    return { required, findings: [] };
  }
  if (required.size > 0) {
    report.facts.branch_protection = `requires ${[...required].join(", ")}`;
    return { required, findings: [] };
  }
  const unprotected = classic === "unprotected" && rules === 0;
  report.facts.branch_protection = unprotected
    ? "none: no branch protection and no ruleset"
    : "requires no checks";
  return {
    required,
    findings: [
      {
        id: "fact:no-required-checks",
        severity: "info",
        message: unprotected
          ? `${base} is unprotected (no branch protection and no ruleset), so it requires no status checks: a failing gate does not block a merge, and a push can land on it without a pull request`
          : `${base} is protected but requires no status checks: a failing gate does not block a merge`,
      },
    ],
  };
}

/** A required check that ran on none of the recent merged pull requests. */
function checksThatNeverRan(checks: string[], pulls: Pull[]): Finding[] {
  const ran = new Set(
    pulls.flatMap((p) =>
      (p.statusCheckRollup ?? []).map((c) => c.name ?? c.context ?? ""),
    ),
  );
  return checks
    .filter((check) => !ran.has(check))
    .map((check) => ({
      id: `derivation:required-check:${check}`,
      severity: "error",
      message: `required check "${check}" ran on none of the last ${pulls.length} merged pull requests: it was renamed, or merges go around it`,
    }));
}

/** Record `suggestions` on the report, and the finding each one makes. */
function offer(report: FitReport, suggestions: Suggestion[]): Finding[] {
  report.suggestions.push(...suggestions);
  return suggestions.map((s) => ({
    id: suggestionId(s),
    severity: "suggestion",
    message: s.message,
  }));
}

/** Declared review bots that never reviewed, or, with none declared, likely ones. */
async function reviewBotFindings(
  config: Config,
  pulls: Pull[],
  root: string,
  report: FitReport,
): Promise<Finding[]> {
  const authors = reviewerCounts(pulls);
  const declaredBots = texts(at(config, "review.bots"));
  const findings: Finding[] = declaredBots
    .filter((bot) => !authors.has(normalLogin(bot)))
    .map((bot) => ({
      id: `contradiction:review.bots:${bot}`,
      severity: "warning",
      message: `review.bots names ${bot}, which reviewed or commented on none of the last ${pulls.length} merged pull requests`,
    }));
  if (declaredBots.length > 0) return findings;
  const { found, unconfirmed } = await reviewBots(pulls, root);
  const bots = found.map((bot) =>
    suggest(
      bot,
      `${bot.evidence.join("; ")}: list it in review.bots so the review skills work its threads`,
      { key: bot.login },
    ),
  );
  const unchecked = unconfirmed.map(
    ({ login, evidence }): Finding => ({
      id: `unchecked:review.bots:${login}`,
      severity: "info",
      message: `${evidence}, but whether it is a bot could not be read, so the login review.bots needs is unchecked: no value is suggested`,
    }),
  );
  return [...findings, ...offer(report, bots), ...unchecked];
}

/** What the recent merged pull requests show: required checks and reviewers. */
async function mergedPullFindings(
  config: Config,
  root: string,
  base: string,
  required: Set<string>,
  report: FitReport,
  state: ForgeState,
): Promise<Finding[]> {
  const pulls = await mergedPulls(base, root);
  state.pulls = pulls;
  if (pulls === null)
    return [
      {
        id: "unchecked:merged-pulls",
        severity: "info",
        message:
          "recent merged pull requests could not be read: whether required checks run is unchecked",
      },
    ];
  if (pulls.length === 0)
    return [
      {
        id: "unchecked:merged-pulls",
        severity: "info",
        message: `no pull request has merged into ${base} yet: whether required checks run, and who reviews, is unchecked`,
      },
    ];
  const declared = at(config, "ci.required_checks");
  const checks = Array.isArray(declared) ? texts(declared) : [...required];
  return [
    ...checksThatNeverRan(checks, pulls),
    ...(await reviewBotFindings(config, pulls, root, report)),
    ...reviewerFindings(config, pulls),
  ];
}

/** Whether the open pull requests and the repository fit `pull_requests.stacking`. */
async function stackingFindings(
  config: Config,
  root: string,
  base: string,
  repo: ForgeRepo,
  report: FitReport,
): Promise<Finding[]> {
  const pulls = await openPulls(root);
  if (pulls === null)
    return [
      {
        id: "unchecked:open-pulls",
        severity: "info",
        message: "open pull requests could not be read: stacking is unchecked",
      },
    ];
  const findings: Finding[] = [];
  const { stacked, unresolved } = stackedPulls(pulls, base);
  report.facts.stacked_open_pulls = String(stacked.length);
  if (unresolved.length > 0) {
    report.facts.stacked_open_pulls = `at least ${stacked.length}`;
    findings.push({
      id: "unchecked:stacked-open-pulls",
      severity: "info",
      message: `only ${OPEN_PULL_LIMIT} open pull requests were read, and ${unresolved.length} of them are based on a branch none of those is: whether they are stacked is unchecked`,
    });
  }
  const declaredStacking = at(config, "pull_requests.stacking");
  const stacking =
    typeof declaredStacking === "string" ? declaredStacking : "none";
  if (stacking === "none" && stacked.length > 0)
    findings.push(
      ...stackedWithoutStacking(declaredStacking, base, stacked, report),
    );
  if (stacking === "branch" && repo.deleteBranchOnMerge === false)
    findings.push({
      id: "contradiction:delete-branch-on-merge",
      severity: "warning",
      message:
        "pull_requests.stacking is branch, but the repository keeps head branches after merging, so GitHub does not retarget the layer above a merged one",
    });
  return findings;
}

/**
 * Open pull requests stacked while `pull_requests.stacking` reads as none: a
 * warning when the file says none, and a suggested value when it says nothing.
 */
function stackedWithoutStacking(
  declared: unknown,
  base: string,
  stacked: OpenPull[],
  report: FitReport,
): Finding[] {
  const finding = {
    id: "contradiction:pull_requests.stacking",
    message: `${stacked.length} open pull request(s) are based on another open pull request's branch, not ${base} (${stacked
      .slice(0, 5)
      .map((p) => `#${p.number} → ${p.baseRefName}`)
      .join(", ")}), but pull_requests.stacking is ${
      declared === undefined ? "unset (none)" : "none"
    }: declare native or branch, or stop stacking`,
  };
  if (declared !== undefined) return [{ ...finding, severity: "warning" }];
  return offer(report, [stackingSuggestion(base, stacked, finding)]);
}

/** Configured pull-request labels the repository does not have. */
async function labelFindings(
  config: Config,
  root: string,
  slug: string,
): Promise<Finding[]> {
  const labels = texts(at(config, "pull_requests.labels"));
  if (labels.length === 0) return [];
  const list = await ghJson(
    ["label", "list", "--limit", "1000", "--json", "name"],
    root,
  );
  if (!list.ok || !Array.isArray(list.value))
    return [
      {
        id: "unchecked:pull_requests.labels",
        severity: "info",
        message:
          "the repository's labels could not be read: whether pull_requests.labels exist is unchecked",
      },
    ];
  const names = new Set((list.value as { name: string }[]).map((l) => l.name));
  return labels
    .filter((label) => !names.has(label))
    .map((label) => ({
      id: `derivation:pull_requests.labels:${label}`,
      severity: "error",
      message: `pull_requests.labels names ${label}, which does not exist in ${slug}: opening a pull request fails`,
    }));
}

/**
 * The integration branch: the declared one, else the forge's default branch,
 * else the clone's origin/HEAD. The forge's answer is current, while
 * origin/HEAD is set at clone time and moves only when asked to, so a clone
 * whose origin/HEAD names another branch is warned.
 */
function forgeBase(
  repo: ForgeRepo,
  report: FitReport,
): { base: string | null; findings: Finding[] } {
  const current = report.facts.integration_branch ?? null;
  const source = report.facts.integration_branch_source;
  const forgeDefault = repo.defaultBranchRef?.name;
  if (source === "repository.base_branch" || !forgeDefault)
    return { base: current, findings: [] };
  report.facts.integration_branch = forgeDefault;
  report.facts.integration_branch_source = "the forge's default branch";
  if (source !== "origin/HEAD" || current === forgeDefault)
    return { base: forgeDefault, findings: [] };
  return {
    base: forgeDefault,
    findings: [
      {
        id: "fact:origin-head-differs",
        severity: "warning",
        message: `this clone's origin/HEAD names ${current}, but the forge's default branch is ${forgeDefault}: the audit uses ${forgeDefault}. Run \`git remote set-head origin --auto\` so the clone agrees, or set repository.base_branch: ${current} if that is the integration branch`,
      },
    ],
  };
}

/** What the forge checks learnt that the later checks read. */
interface ForgeState {
  /** The checks the integration branch requires; null when unread. */
  required: Set<string> | null;
  /** The recent merged pull requests; null when unread. */
  pulls: Pull[] | null;
}

async function forgeChecks(
  config: Config,
  root: string,
  report: FitReport,
  state: ForgeState,
): Promise<Finding[]> {
  const view = await forgeRepo(root);
  if (!view.ok) {
    report.forge = "unchecked";
    return [
      {
        id: "unchecked:forge",
        severity: "info",
        message: `the forge could not be read (${view.reason.split("\n")[0]}): branch protection, required checks, open pull requests and labels are unchecked`,
      },
    ];
  }
  report.forge = "checked";
  const repo = view.value;
  const slug = repo.nameWithOwner;
  report.facts.repository = slug;
  const { base, findings: baseFindings } = forgeBase(repo, report);
  if (base === null) return baseFindings;
  const { required, findings } = await requiredChecks(slug, base, root, report);
  if (!report.facts.branch_protection?.startsWith("unchecked"))
    state.required = required;
  // In this order: each reading's suggestions join the report as it runs.
  const merged = await mergedPullFindings(
    config,
    root,
    base,
    required,
    report,
    state,
  );
  const stacking = await stackingFindings(config, root, base, repo, report);
  const labels = await labelFindings(config, root, slug);
  return [
    ...baseFindings,
    ...findings,
    ...merged,
    ...stacking,
    ...labels,
    ...offer(report, repoSlugSuggestion(config, repo)),
  ];
}

/**
 * Ask the tracker the configuration selects whether it answers for the
 * audited repository: its credential and its team or repository, never an
 * issue, whose contents are no part of reachability. The configuration is
 * `file` merged with this machine's user file and environment, as the skills
 * read it; one that sets no `issue_tracker` section is probed too: it runs on
 * the default adapter, which derives its repository from `root`'s `origin`.
 */
async function trackerCheck(
  file: string,
  configured: boolean,
  root: string,
): Promise<Finding[]> {
  if (!configured) return [];
  let config: Config | undefined;
  try {
    const text = readFileSync(file, "utf8");
    config = layeredConfig(root, process.env, text).values;
    const trackerConfig = parseTrackerConfig(config);
    if (!trackerProbeable(trackerConfig)) return [];
    const deadline = new AbortController();
    const probe = openTracker(trackerConfig, root).reach(deadline.signal);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("no answer within 30 seconds"));
        deadline.abort();
      }, 30_000).unref(),
    );
    await Promise.race([probe, timeout]);
    return [];
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return [
      {
        id: "derivation:issue_tracker",
        severity: "error",
        message:
          config === undefined
            ? `the tracker is unchecked: the configuration the skills read cannot be loaded, so every skill here refuses to run (${reason})`
            : `the ${String(at(config, "issue_tracker.adapter") ?? "github")} tracker cannot be reached: ${reason}`,
      },
    ];
  }
}

/**
 * With no gate command set, the one the repository's shape names
 * (`gateCommand` in the detector).
 */
function gateFindings(
  config: Config,
  root: string,
  files: string[],
  report: FitReport,
): Finding[] {
  if (at(config, "gates.command") !== undefined) return [];
  const gate = gateCommand(root, files);
  if (gate === null)
    return [
      {
        id: "suggestion:gates.command",
        severity: "suggestion",
        message:
          "no single command runs the repository's checks: add one and set gates.command to it (resolve-review-comments requires it)",
      },
    ];
  return offer(report, [
    suggest(
      gate,
      gate.unsettled === undefined
        ? `set gates.command: ${gate.value}, the repository's whole local check, so the review and CI skills run it before every push`
        : `${gate.value} is the repository's check, but ${gate.unsettled}: set gates.command to the command that runs all of what CI runs, since ${gate.value} alone may run less`,
    ),
  ]);
}

/** The settings the repository's own files suggest. */
function suggestions(
  config: Config,
  root: string,
  files: string[],
  report: FitReport,
): Finding[] {
  return [
    ...offer(report, catalogSuggestion(config, files)),
    ...gateFindings(config, root, files, report),
  ];
}

function integrationBranch(
  config: Config,
  root: string,
  report: FitReport,
): Finding[] {
  const declared = at(config, "repository.base_branch");
  const hasOrigin =
    run("git", ["remote", "get-url", "origin"], { cwd: root }).code === 0;
  if (typeof declared === "string" && declared !== "") {
    report.facts.integration_branch = declared;
    report.facts.integration_branch_source = "repository.base_branch";
    if (!hasOrigin)
      return [
        {
          id: "unchecked:repository.base_branch",
          severity: "info",
          message: `the clone has no origin remote, so whether ${declared} exists there is unchecked`,
        },
      ];
    const found = run(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${declared}`],
      { cwd: root },
    );
    return found.code === 0
      ? []
      : [
          {
            id: "derivation:repository.base_branch",
            severity: "error",
            message: `repository.base_branch is ${declared}, but origin has no such branch (fetch, or correct the name)`,
          },
        ];
  }
  const head = originHead(root);
  if (head !== null) {
    report.facts.integration_branch = head.value;
    report.facts.integration_branch_source = "origin/HEAD";
  }
  return [];
}

/**
 * How many commits of the integration branch HEAD lacks, from the clone's
 * own refs as of its last fetch (the audit never fetches). An audit of a
 * checkout behind it describes a commit the team has moved past.
 */
function behindIntegrationBranch(root: string, report: FitReport): Finding[] {
  const branch = report.facts.integration_branch;
  if (branch === undefined) return [];
  if (run("git", ["remote", "get-url", "origin"], { cwd: root }).code !== 0)
    return [];
  const ref = `refs/remotes/origin/${branch}`;
  const known =
    run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root })
      .code === 0;
  if (!known)
    return report.facts.integration_branch_source === "repository.base_branch"
      ? []
      : [
          {
            id: "unchecked:behind-integration-branch",
            severity: "info",
            message: `this clone has no origin/${branch} (fetch it), so whether HEAD lacks its commits is unchecked`,
          },
        ];
  const count = run("git", ["rev-list", "--count", `HEAD..${ref}`], {
    cwd: root,
  });
  const behind = Number(count.stdout.trim());
  if (count.code !== 0 || !Number.isInteger(behind)) return [];
  report.facts.behind_integration_branch = `${behind} commit(s) of origin/${branch} not in HEAD, as of the last fetch`;
  if (behind === 0) return [];
  return [
    {
      id: "fact:behind-integration-branch",
      severity: "warning",
      message: `HEAD lacks ${behind} commit(s) of origin/${branch} (as of the last fetch): the audit would describe a stale commit. Fetch, then check out or rebase onto origin/${branch} before scoring`,
    },
  ];
}

/** The configuration file of the `groundwork` plugin, which Jig's skills do not read. */
const LEGACY_OVERLAY = ".config/groundwork-overlay.yaml";

/**
 * The `groundwork` plugin's names, which no Jig skill reads, each with what
 * replaces it.
 */
const LEGACY_NAMES: [RegExp, string, string][] = [
  [/\/groundwork:/, "/groundwork:", "change `/groundwork:` to `/jig:`"],
  [
    /groundwork@groundwork/,
    "groundwork@groundwork",
    "change `groundwork@groundwork` to `jig@jig`",
  ],
  [
    /\.groundwork\//,
    ".groundwork/",
    "remove what refers to `.groundwork/`, the per-worktree installer's folder",
  ],
  [/GROUNDWORK_/, "GROUNDWORK_", "rename `GROUNDWORK_*` variables to `JIG_*`"],
];

/** Tracked files that instruct agents or configure tools, where the old names would matter. */
function scansForLegacyNames(file: string): boolean {
  if (file === LEGACY_OVERLAY || file === RECORD_RELPATH) return false;
  return (
    /(^|\/)(AGENTS|CLAUDE)\.md$/i.test(file) ||
    /^\.(claude|agents|cursor|config)\//.test(file) ||
    /^\.(cursorrules|mcp\.json)$/.test(file) ||
    /^\.github\/(copilot-instructions\.md$|instructions\/)/.test(file) ||
    /^\.?mise\.toml$/.test(file)
  );
}

/** A leftover overlay of the `groundwork` plugin, and the old names tracked files still use. */
function legacyFindings(
  root: string,
  files: string[],
  configured: boolean,
): Finding[] {
  const findings: Finding[] = [];
  if (existsSync(join(root, LEGACY_OVERLAY)))
    findings.push(
      configured
        ? {
            id: "legacy-overlay",
            severity: "warning",
            message: `${LEGACY_OVERLAY} is the former groundwork plugin's file, which no Jig skill reads, beside ${OVERLAY_RELPATH}: move any value ${OVERLAY_RELPATH} lacks into it, then \`git rm ${LEGACY_OVERLAY}\``,
          }
        : {
            id: "legacy-overlay",
            severity: "error",
            message: `${LEGACY_OVERLAY} is the former groundwork plugin's file, which no Jig skill reads, so the repository runs unconfigured: \`git mv ${LEGACY_OVERLAY} ${OVERLAY_RELPATH}\`, then run this check again for the fields that changed`,
          },
    );
  for (const file of files.filter(scansForLegacyNames)) {
    const finding = legacyReference(root, file);
    if (finding !== null) findings.push(finding);
  }
  return findings;
}

/** The lines of one tracked file that use the `groundwork` plugin's names, as a finding. */
function legacyReference(root: string, file: string): Finding | null {
  const path = join(root, file);
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 1_000_000) return null;
  const text = readFileSync(path, "utf8");
  if (text.includes("\0")) return null;
  const at: number[] = [];
  const used = new Set<number>();
  for (const [i, line] of text.split("\n").entries()) {
    const hits = LEGACY_NAMES.flatMap(([pattern], n) =>
      pattern.test(line) ? [n] : [],
    );
    if (hits.length === 0) continue;
    at.push(i + 1);
    for (const n of hits) used.add(n);
  }
  if (at.length === 0) return null;
  const kinds = [...used].sort().map((n) => LEGACY_NAMES[n]);
  const shown = at.slice(0, 10).map((line) => `${file}:${line}`);
  return {
    id: `legacy-reference:${file}`,
    severity: "warning",
    message: `${shown.join(", ")}${at.length > 10 ? ` and ${at.length - 10} more` : ""} name${at.length === 1 ? "s" : ""} the former groundwork plugin (${kinds.map((k) => `\`${k?.[1]}\``).join(", ")}), which nothing reads any more: ${kinds.map((k) => k?.[2]).join("; ")} (plugin README, "Moving from the groundwork plugin")`,
  };
}

/** What replaces each field the `groundwork` overlay used that Jig does not know. */
const LEGACY_FIELDS: Record<string, string> = {
  schema_version:
    "it versioned that file's format, and Jig's file has no version, so dropping it is safe",
  repo_label: "Jig reads it as review.repo_label; move it there",
  rules:
    "no Jig skill reads it, so dropping it changes nothing a skill does; keep any rule agents need in the repository's instructions (AGENTS.md)",
  harness:
    "no Jig skill reads it; the tools a skill needs beyond git, gh and bun go into permissions.allow in .claude/settings.json, after which dropping it is safe",
  "review.dormant_check_pattern":
    "drive-pr waits for an AI reviewer only when review.reviewer_app or review.reviewer_check_pattern names one, so a dormant check needs no pattern; dropping it is safe",
  "issue_tracker.system": "Jig reads it as issue_tracker.adapter; rename it",
};

/** Unknown-field findings for a field the `groundwork` overlay used, told what replaces it. */
function legacyFields(findings: Finding[]): Finding[] {
  return findings.map((finding) => {
    const path = finding.id.startsWith("unknown:")
      ? finding.id.slice("unknown:".length)
      : undefined;
    const note = path === undefined ? undefined : LEGACY_FIELDS[path];
    return note === undefined
      ? finding
      : {
          ...finding,
          message: `${finding.message} It is left from the former groundwork overlay: ${note}.`,
        };
  });
}

/**
 * `.context/` not ignored by git. A drive keeps working files there and
 * refuses to push or certify a tree with untracked files.
 */
function contextDirFindings(root: string): Finding[] {
  const probe = run("git", ["check-ignore", "-q", ".context/jig-probe"], {
    cwd: root,
  });
  if (probe.code === 0) return [];
  if (probe.code !== 1)
    return [
      {
        id: "unchecked:context-dir-not-ignored",
        severity: "info",
        message: `whether git ignores .context/ could not be read (${(probe.stderr.trim().split("\n")[0] ?? "") || `exit ${probe.code}`}), so it is unchecked`,
      },
    ];
  return [
    {
      id: "context-dir-not-ignored",
      severity: "warning",
      message:
        "git does not ignore .context/: a drive keeps working files there and refuses to push or certify a tree with untracked files. Add `.context/` to .gitignore",
    },
  ];
}

/**
 * Where a slash command in `issue_tracker.file_command` resolves: a command
 * or skill the repository tracks, or a skill of this plugin. Another
 * plugin's command is out of the audit's sight, so it is unchecked; a
 * command line that is not a slash command is an instruction no skill runs.
 */
function fileCommandFindings(config: Config, files: string[]): Finding[] {
  const value = at(config, "issue_tracker.file_command");
  if (typeof value !== "string") return [];
  const name = /^\/([A-Za-z0-9_.:-]+)/.exec(value.trim())?.[1];
  if (name === undefined) return [];
  const [plugin, command] = name.includes(":")
    ? (name.split(":", 2) as [string, string])
    : [undefined, name];
  if (plugin !== undefined && plugin !== "jig")
    return [
      {
        id: "unchecked:issue_tracker.file_command",
        severity: "info",
        message: `issue_tracker.file_command names /${name}, a command of the ${plugin} plugin, which this audit cannot see: whether it exists is unchecked`,
      },
    ];
  const places =
    plugin === "jig"
      ? []
      : [
          `.claude/commands/${command}.md`,
          `.claude/skills/${command}/SKILL.md`,
          `.agents/skills/${command}/SKILL.md`,
        ];
  // A bare name runs a plugin's skill too, when nothing else has the name.
  const jigSkill = existsSync(join(skillDir(), "..", command, "SKILL.md"));
  const found =
    jigSkill ||
    (plugin === undefined &&
      files.some(
        (f) =>
          places.includes(f) ||
          (f.startsWith(".claude/commands/") && f.endsWith(`/${command}.md`)),
      ));
  if (found) return [];
  return [
    {
      id: "derivation:issue_tracker.file_command",
      severity: "warning",
      message: `issue_tracker.file_command is \`${value}\`, but /${name} resolves to ${
        plugin === "jig"
          ? "no skill of this plugin"
          : `nothing the repository tracks (${places.join(", ")}) and no skill of this plugin`
      }: unless every machine that works here installs it (a user command, or another plugin's skill), an agent told to file an issue with it cannot. Add that command to the repository, or set the field to one that exists`,
    },
  ];
}

/**
 * Whether a check name is the one `job` reports: its name, or with a matrix
 * suffix; a name built from an expression matches on the text before it.
 */
function reportsCheck(job: CiJob, check: string): boolean {
  const c = check.toLowerCase();
  const expression = job.name.indexOf("${{");
  if (expression >= 0) {
    const prefix = job.name.slice(0, expression).trim().toLowerCase();
    return prefix !== "" && c.startsWith(prefix);
  }
  const n = job.name.toLowerCase();
  return c === n || c.startsWith(`${n} (`) || c === job.id.toLowerCase();
}

/** Programs and commands a CI step runs to set up, not to check. */
const SETUP_PROGRAMS = new Set([
  ...BUILTINS,
  "cd",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "ln",
  "cat",
  "ls",
  "tee",
  "touch",
  "chmod",
  "sleep",
  "curl",
  "wget",
  "git",
  "gh",
  "sudo",
  "apt",
  "apt-get",
  "brew",
  "corepack",
]);
const SETUP_COMMAND =
  /^(npm (ci|install|i)|pnpm (install|i|fetch)|yarn install|yarn(?=(\s+-\S*)*$)|bun (install|i)|pipx? install|pip3 install|python3? -m pip install|poetry install|uv (sync|pip)|bundle install|go mod download|cargo fetch|mise (install|use|trust)|(npx |bunx |pnpm exec |pnpm dlx )?playwright install)(\s|$)/;

/** The package script a runner command runs (`npm test`, `pnpm lint`, `bun run gates`), if any. */
function scriptRun(
  words: string[],
  scripts: Record<string, string>,
): string | undefined {
  const [program, ...args] = words;
  if (program === undefined || !RUNNERS.has(program)) return undefined;
  if (args.some((a) => ELSEWHERE.has(a.split("=")[0] ?? ""))) return undefined;
  const [first, second] = operandsOf(args);
  if (first === "run" || first === "run-script") return second;
  if (first === undefined) return undefined;
  if (program === "npm")
    return NPM_SCRIPT_ALIASES.has(first) ? "test" : undefined;
  if (RUNNER_COMMANDS[program]?.has(first)) return undefined;
  return Object.hasOwn(scripts, first) ? first : undefined;
}

/** One command of a command line, as the gate comparison reads it. */
interface RunKey {
  /** `script:<name>` for a package script, else its program and operands. */
  key: string;
  setup: boolean;
  script?: string;
  /** The operands that name files, such as `scripts/check.ts`. */
  files: string[];
  program: string;
}

/**
 * The comparable commands of one command line; null for a line this scan
 * cannot read as a shell would (expressions, redirections, a `cd`), which is
 * left out rather than guessed at.
 */
function lineKeys(
  line: string,
  scripts: Record<string, string>,
): RunKey[] | null {
  if (line.includes("${{")) return null;
  const { segments, syntax, unsupported } = scan(line);
  if (syntax !== null || unsupported !== null) return null;
  const keys: RunKey[] = [];
  for (const segment of segments) {
    const words = commandWords(segment);
    if (typeof words === "string" || words[0] === "cd") return null;
    const [program, ...args] = words;
    if (program === undefined) continue;
    const operands = operandsOf(args);
    const script = scriptRun(words, scripts);
    // Flags are left out: `bun test --coverage` runs what `bun test` does.
    keys.push({
      key:
        script === undefined
          ? [program, ...operands].join(" ")
          : `script:${script}`,
      setup: SETUP_PROGRAMS.has(program) || SETUP_COMMAND.test(words.join(" ")),
      ...(script === undefined ? {} : { script }),
      files: [program, ...operands].filter(
        (w) => w.includes("/") || SCRIPT_FILE.test(w),
      ),
      program,
    });
  }
  return keys;
}

/** What the gate command runs, compared by text. */
interface GateRun {
  /** Its commands, and those of each package script it runs, one level deep. */
  keys: Set<string>;
  /** The files and makefile it runs, which may run more by name. */
  texts: RunFile[];
}

/** A file a command runs: its name, which tells its language, and its text. */
interface RunFile {
  name: string;
  text: string;
}

/** The text of a file a command runs, when it is a readable file of modest size. */
function runFileText(root: string, name: string): RunFile[] {
  const path = onDisk(root, name);
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size < 1_000_000
    ? [{ name, text: readFileSync(path, "utf8") }]
    : [];
}

function gateRun(
  command: string,
  scripts: Record<string, string>,
  root: string,
): GateRun {
  const run: GateRun = { keys: new Set(), texts: [] };
  const add = (k: RunKey) => {
    run.keys.add(k.key);
    for (const file of k.files) run.texts.push(...runFileText(root, file));
    const makefile = k.program === "make" ? makefileOf(root) : undefined;
    if (makefile !== undefined) run.texts.push(...runFileText(root, makefile));
  };
  for (const k of lineKeys(command, scripts) ?? []) {
    add(k);
    const body = k.script === undefined ? undefined : scripts[k.script];
    if (body !== undefined)
      for (const inner of lineKeys(body, scripts) ?? []) add(inner);
  }
  return run;
}

/** Words that run the file named after them: a shell, a script runtime, `source`. */
const RUNNER =
  "(?:bash|sh|zsh|dash|ksh|fish|pwsh|bun(?:\\s+run)?|node|deno\\s+run(?:\\s+-\\S+)*|tsx|ts-node|python3?|ruby|perl|source|\\.)";
/** Where a shell line or makefile recipe starts a command, a command substitution included. */
const COMMAND_START =
  "(?:^|[;&|`]|\\$\\(|\\b(?:then|do|else|exec)\\s)\\s*[@-]?";
/** A call that runs the program its first argument names. */
const SPAWN =
  "(?:\\bspawn(?:Sync)?|\\bexecFile(?:Sync)?|\\bexec(?:Sync)?|\\$)\\s*\\(?\\s*\\[?\\s*";
/** A call that runs a program with its arguments, as a list or one by one. */
const ARGV_CALL =
  "\\b(?:run|spawn(?:Sync)?|execFile(?:Sync)?|execa(?:Sync)?|call|check_call|check_output|Popen)\\s*\\(\\s*\\[?\\s*";

/** The language a runner's text is read in, which decides its comments and strings. */
type Dialect = "shell" | "js" | "python";

/** A file's language, by its extension, else its `#!` line; a shell (or makefile) otherwise. */
function dialectOf(run: RunFile): Dialect {
  const ext = /\.([A-Za-z]+)$/.exec(run.name)?.[1]?.toLowerCase();
  if (ext !== undefined && /^[cm]?[jt]sx?$/.test(ext)) return "js";
  if (ext === "py") return "python";
  const shebang = /^#!.*/.exec(run.text)?.[0] ?? "";
  if (/\b(?:node|bun|deno|tsx|ts-node)\b/.test(shebang)) return "js";
  if (/\bpython/.test(shebang)) return "python";
  return "shell";
}

/**
 * Where a lexer is: code (the top level, a shell `$(…)` or a JavaScript
 * `${…}`, with the brackets it has open), a shell double-quoted string, a
 * shell backtick substitution, the body of a shell here-document whose
 * delimiter is unquoted, or a JavaScript template's text.
 */
interface Frame {
  kind: "code" | "paren" | "interp" | "dq" | "tick" | "body" | "template";
  depth: number;
  /** Shell here-documents opened on the current line, whose bodies start on the next. */
  heredocs?: Heredoc[];
  /** In a `body` frame: the here-document it is the body of. */
  doc?: Heredoc;
  /** In a `body` frame: the last position of the logical line being read. */
  lineEnd?: number;
}

/**
 * A shell here-document: its closing word with quotes removed, whether `<<-`
 * lets tabs indent it, and whether any part of the delimiter was quoted,
 * which leaves the whole body text.
 */
interface Heredoc {
  word: string;
  tabs: boolean;
  quoted: boolean;
}

/**
 * One step of a lexer at position `i`: marks the positions it reads that are
 * code and returns the last position it read.
 */
type LexStep = (
  text: string,
  i: number,
  code: boolean[],
  stack: Frame[],
) => number;

/**
 * For each position of a text, whether it is code rather than the inside of
 * a string or a comment, read by one language's step. State carries across
 * lines; an opening quote counts as code.
 */
function lex(text: string, step: LexStep): boolean[] {
  const code: boolean[] = new Array(text.length).fill(false);
  const stack: Frame[] = [{ kind: "code", depth: 0 }];
  for (let i = 0; i < text.length; i++) i = step(text, i, code, stack);
  return code;
}

/** The last position of the line `i` is on. */
function lineEnd(text: string, i: number): number {
  const end = text.indexOf("\n", i);
  return (end === -1 ? text.length : end) - 1;
}

/**
 * The position that ends a string opened at `i` by `close`: its closing
 * quote, the end of the line when it cannot span lines, or the end of the text.
 */
function stringEnd(
  text: string,
  i: number,
  close: string,
  { escapes, oneLine }: { escapes: boolean; oneLine: boolean },
): number {
  for (let j = i + close.length; j < text.length; j++) {
    if (escapes && text[j] === "\\") j++;
    else if (text.startsWith(close, j)) return j + close.length - 1;
    else if (oneLine && text[j] === "\n") return j;
  }
  return text.length;
}

/** Counts a bracket in a frame that tracks them, leaving the frame when its last one closes. */
function nest(
  c: string | undefined,
  [open, close]: string,
  stack: Frame[],
): void {
  const top = stack[stack.length - 1];
  if (top === undefined) return;
  if (c === open) top.depth++;
  else if (c === close && --top.depth === 0) stack.pop();
}

/** A shell command substitution opening at `i`, entered; the last position read, if one opens. */
function shellSubstitution(
  text: string,
  i: number,
  code: boolean[],
  stack: Frame[],
): number | undefined {
  if (text.startsWith("$(", i)) {
    code[i] = code[i + 1] = true;
    stack.push({ kind: "paren", depth: 1 });
    return i + 1;
  }
  if (text[i] !== "`") return undefined;
  code[i] = true;
  stack.push({ kind: "tick", depth: 0 });
  return i;
}

/**
 * The shell word starting at `i`, up to an unquoted blank, newline or
 * operator character: its text with quotes removed, whether any of it was
 * quoted, and the position after it. Undefined where no word starts, or for
 * a quote left open on its line; a quoted empty word (`''`) is a word.
 */
function shellWord(
  text: string,
  i: number,
): { word: string; quoted: boolean; end: number } | undefined {
  let word = "";
  let quoted = false;
  let j = i;
  while (j < text.length && !/[\s;&|<>()]/.test(text[j] ?? "")) {
    const part = wordPart(text, j);
    if (part === undefined) return undefined;
    word += part.text;
    quoted ||= part.quoted;
    j = part.end;
  }
  return j === i ? undefined : { word, quoted, end: j };
}

/**
 * One character of a shell word at `j`, or the quoted run it opens: its text
 * with quotes removed, whether it was quoted, and the position after it.
 * Inside double quotes a backslash escapes only `$`, a backtick, `"` and
 * itself, as the shell's quote removal does. Undefined for a quote left open
 * on its line.
 */
function wordPart(
  text: string,
  j: number,
): { text: string; quoted: boolean; end: number } | undefined {
  const c = text[j] ?? "";
  if (c === "\\") return { text: text[j + 1] ?? "", quoted: true, end: j + 2 };
  if (c !== "'" && c !== '"') return { text: c, quoted: false, end: j + 1 };
  let part = "";
  for (let k = j + 1; k < text.length && text[k] !== "\n"; k++) {
    const d = text[k] ?? "";
    if (d === c) return { text: part, quoted: true, end: k + 1 };
    const next = text[k + 1] ?? "";
    if (c === '"' && d === "\\" && /[$`"\\]/.test(next)) {
      part += next;
      k++;
    } else part += d;
  }
  return undefined;
}

/** Whether a line ends in a backslash that escapes its newline: an odd run of them. */
function continues(line: string): boolean {
  return /(?:^|[^\\])(?:\\\\)*\\$/.test(line);
}

/**
 * The here-document body line starting at `start`, and its last position.
 * An unquoted body joins a line ending in a backslash-newline to the next,
 * before its closing line is looked for; a quoted body's lines are its
 * physical lines.
 */
function bodyLine(
  text: string,
  start: number,
  { quoted }: Heredoc,
): { line: string; end: number } {
  let line = "";
  for (let at = start; ; ) {
    const end = lineEnd(text, at);
    const physical = text.slice(at, end + 1);
    if (quoted || !continues(physical) || text[end + 1] !== "\n")
      return { line: line + physical, end };
    line += physical.slice(0, -1);
    at = end + 2;
  }
}

/** Whether a here-document body line is its closing line. */
function closes(line: string, { word, tabs }: Heredoc): boolean {
  return (tabs ? line.replace(/^\t+/, "") : line) === word;
}

/**
 * A here-document operator at `i`, recorded on the frame; the last position
 * it read, if one is there. A here-string (`<<<`) is read whole and opens
 * none, and neither does an operator no later line closes (an arithmetic
 * shift, a word the shell would read differently), so a misreading never
 * hides the rest of the file.
 */
function heredocStart(
  text: string,
  i: number,
  stack: Frame[],
): number | undefined {
  if (text.startsWith("<<<", i)) return i + 2;
  const op = /<<(-?)[ \t]*/y;
  op.lastIndex = i;
  const found = op.exec(text);
  const frame = stack[stack.length - 1];
  if (found === null || frame === undefined) return undefined;
  const delimiter = shellWord(text, op.lastIndex);
  if (delimiter === undefined) return undefined;
  const doc = {
    word: delimiter.word,
    tabs: found[1] === "-",
    quoted: delimiter.quoted,
  };
  let closed = false;
  for (let at = lineEnd(text, i) + 2; at < text.length && !closed; ) {
    const { line, end } = bodyLine(text, at, doc);
    closed = closes(line, doc);
    at = end + 2;
  }
  if (!closed) return undefined;
  frame.heredocs = [...(frame.heredocs ?? []), doc];
  return delimiter.end - 1;
}

/**
 * The bodies of the here-documents opened on the line ending at `i`: a
 * quoted one's skipped as text, an unquoted one's entered as a `body` frame
 * carrying the ones after it. The last position read.
 */
function heredocBodies(
  text: string,
  i: number,
  docs: Heredoc[],
  stack: Frame[],
): number {
  let at = i;
  for (let doc = docs.shift(); doc !== undefined; doc = docs.shift()) {
    if (!doc.quoted) {
      stack.push({ kind: "body", depth: 0, doc, heredocs: docs.splice(0) });
      return at;
    }
    for (let start = at + 1; start < text.length; start = at + 1) {
      const { line, end } = bodyLine(text, start, doc);
      at = end + 1;
      if (closes(line, doc)) break;
    }
  }
  return Math.min(at, text.length);
}

/**
 * A shell step in an unquoted here-document's body: its closing logical line
 * leaves it (handing the here-documents after it to the frame below), and
 * only a substitution is code there.
 */
const shellBody: LexStep = (text, i, code, stack) => {
  const top = stack[stack.length - 1];
  if (
    top?.doc !== undefined &&
    text[i - 1] === "\n" &&
    i > (top.lineEnd ?? -1)
  ) {
    const { line, end } = bodyLine(text, i, top.doc);
    top.lineEnd = end;
    if (closes(line, top.doc)) {
      stack.pop();
      const below = stack[stack.length - 1];
      if (below !== undefined) below.heredocs = top.heredocs ?? [];
      return end;
    }
  }
  if (text[i] === "\\") return i + 1;
  return shellSubstitution(text, i, code, stack) ?? i;
};

/** A shell step inside double quotes: only a substitution is code there. */
const shellQuoted: LexStep = (text, i, code, stack) => {
  if (text[i] === "\\") return i + 1;
  if (text[i] !== '"') return shellSubstitution(text, i, code, stack) ?? i;
  stack.pop();
  return i;
};

/** A shell step on a quote, a backtick or a bracket in code. */
const shellBracket: LexStep = (text, i, code, stack) => {
  const top = stack[stack.length - 1];
  const c = text[i];
  if (c === '"') stack.push({ kind: "dq", depth: 0 });
  else if (c === "`" && top?.kind === "tick") stack.pop();
  else {
    const opened = shellSubstitution(text, i, code, stack);
    if (opened !== undefined) return opened;
    if (top?.kind === "paren") nest(c, "()", stack);
  }
  return i;
};

/** The shell steps for the frames whose text is not code but for its substitutions. */
const SHELL_TEXT: Partial<Record<Frame["kind"], LexStep>> = {
  dq: shellQuoted,
  body: shellBody,
};

/**
 * A shell or makefile step outside quotes: a `#` that starts a word comments
 * out the rest of the line, a backslash makes the next character literal, a
 * single quote has no escapes, a here-document's body is text but for the
 * substitutions of one whose delimiter is unquoted.
 */
const shellStep: LexStep = (text, i, code, stack) => {
  const top = stack[stack.length - 1];
  const inText = top === undefined ? undefined : SHELL_TEXT[top.kind];
  if (inText !== undefined) return inText(text, i, code, stack);
  const c = text[i];
  if (c === "#" && /[\s;&|()`]/.test(text[i - 1] ?? "\n"))
    return lineEnd(text, i);
  if (c === "\n" && top?.heredocs?.length)
    return heredocBodies(text, i, top.heredocs, stack);
  code[i] = true;
  if (c === "\\") return i + 1;
  if (c === "'")
    return stringEnd(text, i, c, { escapes: false, oneLine: false });
  return (
    (c === "<" ? heredocStart(text, i, stack) : undefined) ??
    shellBracket(text, i, code, stack)
  );
};

/** A JavaScript step inside a template's text: only an interpolation is code there. */
const jsTemplate: LexStep = (text, i, code, stack) => {
  if (text[i] === "\\") return i + 1;
  if (text[i] === "`") {
    stack.pop();
    return i;
  }
  if (!text.startsWith("${", i)) return i;
  code[i] = code[i + 1] = true;
  stack.push({ kind: "interp", depth: 1 });
  return i + 1;
};

/**
 * A JavaScript or TypeScript step in code: `//` and `/* … *\/` comments,
 * strings with escapes, templates. A regular-expression literal is read as
 * code, so a quote inside one can mislead it.
 */
const jsStep: LexStep = (text, i, code, stack) => {
  const top = stack[stack.length - 1];
  if (top?.kind === "template") return jsTemplate(text, i, code, stack);
  if (text.startsWith("//", i)) return lineEnd(text, i);
  if (text.startsWith("/*", i)) {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 1;
  }
  const c = text[i];
  code[i] = true;
  if (c === "'" || c === '"')
    return stringEnd(text, i, c, { escapes: true, oneLine: true });
  if (c === "`") stack.push({ kind: "template", depth: 0 });
  else if (top?.kind === "interp") nest(c, "{}", stack);
  return i;
};

/** A Python step: `#` comments, strings with escapes, triple-quoted ones over several lines. */
const pythonStep: LexStep = (text, i, code) => {
  const c = text[i] ?? "";
  if (c === "#") return lineEnd(text, i);
  code[i] = true;
  if (c !== "'" && c !== '"') return i;
  const triple = text.startsWith(c.repeat(3), i);
  return stringEnd(text, i, triple ? c.repeat(3) : c, {
    escapes: true,
    oneLine: !triple,
  });
};

const LEX_STEPS: Record<Dialect, LexStep> = {
  shell: shellStep,
  js: jsStep,
  python: pythonStep,
};

/**
 * Whether a runner's text runs a file, by the path CI runs it from (without
 * a leading `./`): in a shell or makefile, as a command, after a shell or
 * runtime that runs it, or inside a command substitution; in any language,
 * as the program or script of a spawn call. The command or call must start
 * in code, read for the file's whole text in its own language. A mention
 * anywhere else (a comment, a message, an `echo`, a here-document, an
 * escaped separator, a command-shaped string, an argument list no call runs)
 * or another file of the same name is no evidence the gate runs it.
 */
function executesFile(run: RunFile, file: string): boolean {
  const path = file.replace(/^(\.\/)+/, "");
  if (path === "") return false;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const target = `(?:\\./)?${escaped}(?![\\w.-])`;
  const quote = "[\"'`]";
  const dialect = dialectOf(run);
  const code = lex(run.text, LEX_STEPS[dialect]);
  const isCode = (at: number | undefined) =>
    at !== undefined && (code[at] ?? false);
  // A command's first word must be code; a quoted one must open in code.
  const command = new RegExp(
    `${COMMAND_START}(?:${RUNNER}\\s+)?(${quote})?(${target})`,
    "gmd",
  );
  const calls = [
    new RegExp(`${SPAWN}${quote}(?:${RUNNER}\\s+)?${target}`, "gm"),
    new RegExp(
      `${ARGV_CALL}${quote}${RUNNER}${quote}\\s*,\\s*\\[?\\s*${quote}${target}`,
      "gm",
    ),
  ];
  const found = (r: RegExp, ok: (m: RegExpExecArray) => boolean) => {
    for (let m = r.exec(run.text); m !== null; m = r.exec(run.text)) {
      if (ok(m)) return true;
      r.lastIndex = m.index + 1;
    }
    return false;
  };
  return (
    (dialect === "shell" &&
      found(
        command,
        (m) =>
          isCode(m.index) && isCode((m.indices?.[1] ?? m.indices?.[2])?.[0]),
      )) ||
    calls.some((r) => found(r, (m) => isCode(m.index)))
  );
}

/**
 * Whether the gate covers one CI command: the same command, a file the
 * gate's own files run, or a package script whose every
 * check the gate runs.
 */
function gateCovers(
  gate: GateRun,
  key: RunKey,
  scripts: Record<string, string>,
  depth = 0,
): boolean {
  if (gate.keys.has(key.key)) return true;
  if (
    key.files.length > 0 &&
    key.files.every((f) => gate.texts.some((run) => executesFile(run, f)))
  )
    return true;
  const body = key.script === undefined ? undefined : scripts[key.script];
  if (body === undefined || depth > 0) return false;
  const checks = lineKeys(body, scripts)?.filter((k) => !k.setup);
  return (
    checks !== undefined &&
    checks.length > 0 &&
    checks.every((k) => gateCovers(gate, k, scripts, depth + 1))
  );
}

/**
 * The CI jobs to compare the gate with: those behind the required checks and
 * the jobs they need, or, when those are unknown or match no job, those pull
 * requests trigger.
 */
function comparedJobs(
  jobs: CiJob[],
  required: string[],
): { jobs: CiJob[]; basis: string } {
  const behind = jobs.filter((job) =>
    required.some((check) => reportsCheck(job, check)),
  );
  // A required job that only gathers others' results stands for the jobs it needs.
  for (let i = 0; i < behind.length; i++)
    for (const id of behind[i]?.needs ?? []) {
      const needed = jobs.find(
        (j) => j.file === behind[i]?.file && j.id === id,
      );
      if (needed !== undefined && !behind.includes(needed)) behind.push(needed);
    }
  if (behind.length > 0)
    return { jobs: behind, basis: "the jobs behind the required checks" };
  return {
    jobs: jobs.filter((job) => job.pullRequest),
    basis: "the jobs pull requests run",
  };
}

/**
 * Commands CI runs on a pull request that the gate command does not appear
 * to: a heuristic on command text, so it is a suggestion. The gate command
 * and each package script it runs, one level deep, are compared with the
 * `run` steps of the CI jobs, setup and install steps left out.
 */
function gateCiFindings(
  config: Config,
  root: string,
  files: string[],
  forgeRequired: Set<string> | null,
): Finding[] {
  const command = at(config, "gates.command");
  if (typeof command !== "string" || command.trim() === "") return [];
  const scripts = packageScripts(root) ?? {};
  const declared = at(config, "ci.required_checks");
  const required = Array.isArray(declared)
    ? texts(declared)
    : [...(forgeRequired ?? [])];
  const { jobs, basis } = comparedJobs(ciJobs(root, files), required);
  const missing = notInGate(jobs, gateRun(command, scripts, root), scripts);
  // A step is unread when its block is, or when a line of it is one the
  // comparison cannot read as a shell would (a redirection, an expression).
  const unread = jobs.filter(
    (job) =>
      job.unread > 0 ||
      job.commands.some(({ text }) => lineKeys(text, scripts) === null),
  );
  const unchecked: Finding[] =
    unread.length === 0
      ? []
      : [
          {
            id: "unchecked:gates.command:ci",
            severity: "info",
            message: `${unread.map((job) => `${job.file}, job ${job.id}`).join("; ")} ${unread.length === 1 ? "has" : "have"} \`run\` steps this comparison does not read (a compound command, a here-document or a change of folder, a redirection or an expression, or another folder or shell), so whether gates.command runs what they run is unchecked`,
          },
        ];
  if (missing.size === 0) return unchecked;
  const shown = [...missing.values()].slice(0, 5);
  const more = missing.size > 5 ? ` and ${missing.size - 5} more` : "";
  return [
    ...unchecked,
    {
      id: "suggestion:gates.command:ci",
      severity: "suggestion",
      message: `CI runs commands gates.command does not appear to: ${shown.join(", ")}${more}. This compares command text in ${basis} with gates.command and the package scripts it runs, one level deep, so a check the gate runs another way may be listed. Add what is missing to the gate command so a local run catches what CI does, or decline this finding if it runs in CI only on purpose`,
    },
  ];
}

/** The CI commands the gate does not cover, each with the line and job it came from. */
function notInGate(
  jobs: CiJob[],
  gate: GateRun,
  scripts: Record<string, string>,
): Map<string, string> {
  const missing = new Map<string, string>();
  for (const job of jobs)
    for (const { text: line } of job.commands) {
      const uncovered = (lineKeys(line, scripts) ?? []).filter(
        (key) => !key.setup && !gateCovers(gate, key, scripts),
      );
      for (const key of uncovered)
        if (!missing.has(key.key))
          missing.set(key.key, `\`${line}\` (${job.file}, job ${job.id})`);
    }
  return missing;
}

/** Programs an agent running the skills is already allowed to run. */
const PREAPPROVED = new Set(["git", "gh", "bun", ...BUILTINS]);

/**
 * Whether a Claude Code permission rule allows `command`: `Bash`, `Bash(*)`,
 * a prefix rule (`Bash(pnpm:*)`, `Bash(pnpm *)`) or the exact command.
 */
function allows(rule: string, command: string): boolean {
  if (rule === "Bash") return true;
  const spec = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (spec === undefined) return false;
  if (spec.endsWith(":*")) {
    const prefix = spec.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (spec.endsWith("*")) return command.startsWith(spec.slice(0, -1));
  return command === spec;
}

/**
 * With `.claude/settings.json` present, the programs of `gates.command` its
 * permissions do not allow: an agent running the gates is asked each time.
 */
function gatePermissionFindings(config: Config, root: string): Finding[] {
  const command = at(config, "gates.command");
  const path = join(root, ".claude", "settings.json");
  if (typeof command !== "string" || !existsSync(path)) return [];
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return [
      {
        id: "unchecked:permissions.gates",
        severity: "info",
        message: `.claude/settings.json is not valid JSON (${String(error)}), so whether it allows the gate command is unchecked`,
      },
    ];
  }
  const permissions = isRecord(settings) ? settings.permissions : undefined;
  const allow = texts(isRecord(permissions) ? permissions.allow : undefined);
  const programs = new Set<string>();
  for (const segment of commandSegments(command)) {
    const words = commandWords(segment);
    const program = typeof words === "string" ? undefined : words[0];
    if (program === undefined || PREAPPROVED.has(program)) continue;
    const text = withoutAssignments(segment).join(" ");
    if (!allow.some((rule) => allows(rule, text))) programs.add(program);
  }
  if (programs.size === 0) return [];
  const rules = [...programs].map((p) => `"Bash(${p} *)"`);
  return [
    {
      id: "suggestion:permissions.gates",
      severity: "suggestion",
      message: `.claude/settings.json does not allow ${[...programs].map((p) => `\`${p}\``).join(", ")}, which gates.command (\`${command}\`) runs, so an agent running the gates is asked for permission each time: add ${rules.join(", ")} to permissions.allow`,
    },
  ];
}

/** drive-pr's default name for the AI reviewer's check run, used once a repository names a reviewer. */
const FORMER_REVIEWER_CHECK = /^ai[ _-]?review(\s*\(.+\))?$/i;
/** Check names that look like an AI reviewer's. */
const REVIEWER_LIKE =
  /(^|[^a-z])(ai|llm|claude|codex|gpt|copilot)[ _-]?(code[ _-]?)?review/i;

/** The checks that ran on a pull request: a skipped one did not. */
function ranChecks(pull: Pull): string[] {
  return (pull.statusCheckRollup ?? [])
    .filter((c) => c.conclusion?.toUpperCase() !== "SKIPPED")
    .map((c) => c.name ?? c.context ?? "")
    .filter((name) => name !== "");
}

/**
 * Whether the configured AI reviewer fits the recent merged pull requests:
 * with none named, a reviewer-looking check that ran is one the drive will
 * not wait for; a named one that posted on none of them is one the drive
 * waits for until its timeout.
 */
function reviewerFindings(config: Config, pulls: Pull[]): Finding[] {
  const value = (path: string) => {
    const v = at(config, path);
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  const app = value("review.reviewer_app");
  const pattern = value("review.reviewer_check_pattern");
  if (app === undefined && pattern === undefined) return unnamedReviewer(pulls);
  let check: RegExp;
  try {
    check =
      pattern === undefined ? FORMER_REVIEWER_CHECK : new RegExp(pattern, "i");
  } catch (error) {
    swallow(error, "the schema check reports a malformed reviewer pattern");
    return [];
  }
  const posted = pulls.filter(
    (p) =>
      ranChecks(p).some((name) => check.test(name)) ||
      (app !== undefined &&
        [...(p.reviews ?? []), ...(p.comments ?? [])].some(
          (r) => normalLogin(r.author?.login ?? "") === normalLogin(app),
        )),
  );
  if (posted.length > 0) return [];
  const fields = [
    ...(app === undefined ? [] : [`review.reviewer_app (${app})`]),
    ...(pattern === undefined
      ? []
      : [`review.reviewer_check_pattern (${pattern})`]),
  ];
  return [
    {
      id: "contradiction:review.reviewer",
      severity: "warning",
      message: `${fields.join(" and ")} name${fields.length === 1 ? "s" : ""} an AI reviewer, but none of the last ${pulls.length} merged pull requests shows it: no check matching ${check.source} ran${app === undefined ? "" : `, and ${app} neither reviewed nor commented`}. A drive waits for it until its timeout: correct the name, or remove the field${fields.length === 1 ? "" : "s"} if the repository has no AI reviewer`,
    },
  ];
}

/**
 * A reviewer-looking check that ran on recent pull requests while no reviewer
 * is named. It warns even when drive-pr's default check pattern matches the
 * check: the drive applies that default only once a reviewer is named, so
 * with neither field set it waits for no reviewer. The warning says whether
 * the default matches, which decides what naming the reviewer takes.
 */
function unnamedReviewer(pulls: Pull[]): Finding[] {
  const names = new Set<string>();
  let count = 0;
  for (const p of pulls) {
    const looking = ranChecks(p).filter(
      (name) => FORMER_REVIEWER_CHECK.test(name) || REVIEWER_LIKE.test(name),
    );
    for (const name of looking) names.add(name);
    if (looking.length > 0) count++;
  }
  if (count < 2) return [];
  const listed = [...names].slice(0, 3);
  const quote = (list: string[]) => list.map((n) => `"${n}"`).join(", ");
  const matching = listed.filter((n) => FORMER_REVIEWER_CHECK.test(n));
  const others = listed.filter((n) => !FORMER_REVIEWER_CHECK.test(n));
  const pattern = `the default review.reviewer_check_pattern (${FORMER_REVIEWER_CHECK.source}, matched case-insensitively)`;
  const naming =
    others.length === 0
      ? `${pattern} matches ${listed.length === 1 ? "it" : "them"}, so if a drive should wait for its findings, setting review.reviewer_app to the app that posts it is enough`
      : `${pattern} ${matching.length > 0 ? `matches ${quote(matching)} but ` : ""}does not match ${quote(others)}, so if a drive should wait for its findings, set review.reviewer_check_pattern to a pattern its check name matches, and review.reviewer_app to the app that posts it to count only that app's check`;
  return [
    {
      id: "contradiction:review.reviewer-unnamed",
      severity: "warning",
      message: `${quote(listed)} ran on ${count} of the last ${pulls.length} merged pull requests and looks like an AI reviewer's check, but neither review.reviewer_app nor review.reviewer_check_pattern names a reviewer, so drive-pr will not wait for it: it applies its default check pattern only once a reviewer is named. ${naming[0]?.toUpperCase()}${naming.slice(1)}`,
    },
  ];
}

/** The audit record at `recordPath`, or null when there is none. */
function auditRecord(recordPath: string): AuditRecord | null {
  if (!existsSync(recordPath)) return null;
  return parseRecord(readFileSync(recordPath, "utf8"), recordPath);
}

function declinedRefs(
  recordPath: string,
): Map<
  string,
  { reason: string; revisit_when: string; revisit_after?: string }
> {
  const refs = new Map<
    string,
    { reason: string; revisit_when: string; revisit_after?: string }
  >();
  const record = auditRecord(recordPath);
  if (record === null) return refs;
  for (const d of record.declined)
    for (const ref of d.refs)
      if (ref.startsWith("config/")) refs.set(ref.slice("config/".length), d);
  return refs;
}

export async function configFit(opts: {
  root: string;
  file: string;
  offline: boolean;
  recordPath: string;
}): Promise<FitReport> {
  const report: FitReport = {
    // Relative to the repository when inside it: a report is shared, and the
    // auditor's own folders are not part of it.
    file: relative(opts.root, opts.file).startsWith("..")
      ? opts.file
      : relative(opts.root, opts.file),
    configured: existsSync(opts.file),
    forge: opts.offline ? "offline" : "unchecked",
    facts: {},
    findings: [],
    declined: [],
    suggestions: [],
  };
  const schema = loadSchema();
  let config: Config = {};
  if (report.configured) {
    config = readConfigFile(opts.file) ?? {};
    report.findings.push(...legacyFields(checkConfig(config, schema)));
    report.findings.push(...skillValidation(config, opts.file, opts.root));
    report.findings.push(...crossFieldRules(config));
    report.findings.push(...derivations(config, schema, opts.root));
  } else
    report.findings.push({
      id: "missing-file",
      severity: "info",
      message: `no ${OVERLAY_RELPATH}: drive-pr, the pull-request policy and the procedure skills run on their defaults; resolve-review-comments and do-item's tracker scripts refuse to run`,
    });
  report.findings.push(...machineLayers(config, schema));
  report.findings.push(...staleSession());
  const files = trackedFiles(opts.root);
  if (report.configured)
    report.findings.push(...taxonomyFindings(config, opts.root, files));
  report.findings.push(...legacyFindings(opts.root, files, report.configured));
  report.findings.push(...contextDirFindings(opts.root));
  report.findings.push(...integrationBranch(config, opts.root, report));
  const state: ForgeState = { required: null, pulls: null };
  if (!opts.offline) {
    report.findings.push(
      ...(await forgeChecks(config, opts.root, report, state)),
    );
    report.findings.push(
      ...(await trackerCheck(opts.file, report.configured, opts.root)),
    );
  } else
    report.findings.push({
      id: "unchecked:offline",
      severity: "info",
      message:
        "offline: branch protection, required checks, pull requests, labels and the tracker are unchecked",
    });
  if (report.facts.integration_branch === undefined)
    report.findings.push(unknownIntegrationBranch(opts.root, report));
  else report.findings.push(...behindIntegrationBranch(opts.root, report));
  report.findings.push(
    ...offer(
      report,
      trackerTeamSuggestion(
        config,
        issueKeySources(
          opts.root,
          report.facts.integration_branch,
          state.pulls,
        ),
      ),
    ),
  );
  report.findings.push(...suggestions(config, opts.root, files, report));
  if (report.configured)
    report.findings.push(
      ...fileCommandFindings(config, files),
      ...gateCiFindings(config, opts.root, files, state.required),
      ...gatePermissionFindings(config, opts.root),
    );
  report.profile_facts = profileFacts(
    opts.root,
    files,
    new Date(),
    auditRecord(opts.recordPath)?.profile,
  );
  Object.assign(report.facts, profileFactLines(report.profile_facts));
  applyDeclines(report, opts.recordPath);
  const draft = draftConfig(
    suggestedFacts(report.suggestions),
    schema,
    report.configured ? config : null,
  );
  if (draft !== undefined) report.draft = draft;
  return report;
}

/** Why the integration branch is unknown: unchecked, or an error when it could have been read. */
function unknownIntegrationBranch(root: string, report: FitReport): Finding {
  if (run("git", ["remote", "get-url", "origin"], { cwd: root }).code !== 0)
    return {
      id: "unchecked:integration-branch",
      severity: "info",
      message:
        "the clone has no origin remote, so the integration branch is unchecked",
    };
  if (report.forge !== "checked")
    return {
      id: "unchecked:integration-branch",
      severity: "info",
      message:
        "the clone has no origin/HEAD and the forge was not read, so the integration branch is unchecked",
    };
  return {
    id: "derivation:integration-branch",
    severity: "error",
    message:
      "the integration branch is unknown: set repository.base_branch, or give this clone an origin/HEAD (git remote set-head origin --auto)",
  };
}

/**
 * Move the findings the audit record declines to `declined`, and drop their
 * suggestions, so the starter configuration leaves them out too.
 */
function applyDeclines(report: FitReport, recordPath: string): void {
  const declined = declinedRefs(recordPath);
  const date = today();
  report.findings = report.findings.filter((finding) => {
    const entry = declined.get(finding.id);
    if (
      finding.severity === "error" ||
      !entry ||
      (entry.revisit_after && entry.revisit_after <= date)
    )
      return true;
    report.declined.push({
      finding,
      reason: entry.reason,
      revisit_when: entry.revisit_when,
    });
    return false;
  });
  const kept = new Set(report.findings.map((f) => f.id));
  report.suggestions = report.suggestions.filter((s) =>
    kept.has(suggestionId(s)),
  );
}

const SECTIONS: [Finding["severity"], string][] = [
  ["error", "Errors"],
  ["warning", "Warnings"],
  ["suggestion", "Suggestions"],
  ["info", "Information"],
];

export function render(report: FitReport): string {
  const lines = [`# Configuration fit: ${report.file}`, ""];
  if (!report.configured)
    lines.push("The repository has no configuration file.", "");
  lines.push(`Forge: ${report.forge}.`, "");
  const facts = Object.entries(report.facts);
  if (facts.length > 0) {
    lines.push("## Facts", "");
    for (const [key, value] of facts) lines.push(`- ${key}: ${value}`);
    lines.push("");
  }
  for (const [severity, title] of SECTIONS) {
    const rows = report.findings.filter((f) => f.severity === severity);
    if (rows.length === 0) continue;
    lines.push(`## ${title} (${rows.length})`, "");
    for (const f of rows) lines.push(`- \`config/${f.id}\`: ${f.message}`);
    lines.push("");
  }
  lines.push(...closingSections(report));
  if (report.findings.every((f) => f.severity === "info"))
    lines.push("Nothing to fix.", "");
  return lines.join("\n");
}

/** The report's declined findings and its starter configuration, when present. */
function closingSections(report: FitReport): string[] {
  const lines: string[] = [];
  if (report.declined.length > 0)
    lines.push(
      `## Declined (${report.declined.length})`,
      "",
      ...report.declined.map(
        (d) =>
          `- \`config/${d.finding.id}\`: ${d.reason} Revisit when: ${d.revisit_when}`,
      ),
      "",
    );
  if (report.draft !== undefined)
    lines.push(
      "## Starter configuration",
      "",
      "```yaml",
      report.draft.trimEnd(),
      "```",
      "",
    );
  return lines;
}

/** What `--draft` prints when the repository implies nothing to add. */
export const NOTHING_TO_SUGGEST =
  "Nothing to suggest: the configuration already holds every value the repository implies.";

const USAGE =
  "usage: config-fit.ts [--offline] [--json | --draft] [--record <path>]";

interface Options {
  offline: boolean;
  output: "markdown" | "json" | "draft";
  recordPath?: string | undefined;
}

/** The command line's options, or what is wrong with it. */
function parseArgs(argv: string[]): Options | string {
  const options: Options = { offline: false, output: "markdown" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--offline") options.offline = true;
    else if (
      (arg === "--json" || arg === "--draft") &&
      options.output === "markdown"
    )
      options.output = arg === "--json" ? "json" : "draft";
    else if (arg === "--record" && argv[i + 1] !== undefined)
      options.recordPath = argv[++i];
    else return `unexpected argument ${arg}`;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") {
    console.error(`${options}\n${USAGE}`);
    return 2;
  }
  const root = consumerRoot();
  const report = await configFit({
    root,
    file: overlayPath(),
    offline: options.offline,
    recordPath: options.recordPath ?? join(root, RECORD_RELPATH),
  });
  if (options.output === "draft") {
    process.stdout.write(report.draft ?? `${NOTHING_TO_SUGGEST}\n`);
    return 0;
  }
  console.log(
    options.output === "json"
      ? JSON.stringify(report, null, 2)
      : render(report),
  );
  return report.findings.some((f) => f.severity === "error") ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 2;
    },
  );
}
