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
 *     cannot be found, a required check that never runs, a tracker that
 *     cannot be reached;
 *   - declared values the repository contradicts, such as `stacking: none`
 *     with stacked pull requests open;
 *   - settings the repository's shape suggests but does not use.
 *
 * Each suggested value comes with the fact it was read from, and together
 * they make a starter configuration (`lib/draft.ts`): a whole file for a
 * repository without one, the fields to add for a repository with one.
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
  ENV_PREFIX,
  isMapping as isRecord,
  readConfigFile,
  userConfigPath,
  userLayerEnabled,
} from "../../resolve-review-comments/scripts/lib/config-layers.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import {
  consumerRoot,
  OVERLAY_RELPATH,
  overlayPath,
  parseReviewConfig,
  reviewerSelection,
} from "../../resolve-review-comments/scripts/lib/consumer.ts";
import { adrConfig } from "../../adr/scripts/locate.ts";
import { parsePrPolicy } from "../../drive-pr/scripts/lib/pr-policy.ts";
import { refuseRenamedSection } from "../../do-item/scripts/lib/overlay.ts";
import { parseTrackerConfig } from "../../do-item/scripts/lib/tracker/config.ts";
import { openTracker } from "../../do-item/scripts/lib/tracker/index.ts";
import { detectPackageManager } from "../../fix-ci/scripts/consumer-config.ts";
import { parseRecord, RECORD_RELPATH } from "./lib/record.ts";
import {
  ghJson,
  packageScripts,
  run,
  today,
  trackedFiles,
} from "./lib/repo.ts";
import { draftConfig, type Suggestion, suggestionId } from "./lib/draft.ts";
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
  findings: Finding[];
  declined: { finding: Finding; reason: string; revisit_when: string }[];
  /** The values the repository implies, each behind a `suggestion:` finding. */
  suggestions: Suggestion[];
  /** A starter configuration, or its additions, when anything is suggested. */
  draft?: string;
}

type Config = Record<string, unknown>;

/**
 * The text entries of a list field. A field of the wrong type is already a
 * finding of its own; the derivations read only the entries that could work.
 */
function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v !== "")
    : [];
}

/** A word, or a separator between commands. */
type Token = { word: string } | { separator: string };

/**
 * One piece of a command line: blanks, a separator (`&&`, `||`, `;`, `|`), a
 * single- or double-quoted run (its closing quote captured, empty when
 * missing), or unquoted text. Adjacent pieces other than blanks and
 * separators join into one word.
 */
const PIECE = /(\s+)|(&&|\|\||;|\|)|'([^']*)('?)|"([^"]*)("?)|([^\s;|'"&]+|&)/g;

/**
 * Unquoted text a shell takes literally. Anything else may be expanded,
 * globbed, redirected or grouped, and splitting on blanks and separators
 * alone cannot say what such a line runs.
 */
const PLAIN = /^[\p{L}\p{N}_./:=@%+,#^-]+$/u;

/**
 * Syntax in unquoted or double-quoted text that changes how the rest of a
 * line's quotes and separators are read: an escape, a backtick, or a `$` that
 * opens a span which may hold quotes, blanks and separators (`${…}`, `$(…)`,
 * `$((…))`, `$[…]`, and unquoted `$'…'`, where a backslash escapes the closing
 * quote). Any other `$` is a parameter or a literal `$`, and single-quoted
 * text holds no syntax at all.
 */
const REQUOTES = /[\\`]|\$[{([]/;

/** Whether one piece of a command line, followed by `next`, holds {@link REQUOTES} syntax. */
function requotes(
  blank: string | undefined,
  double: string | undefined,
  text: string | undefined,
  next: string,
): boolean {
  if (blank !== undefined) return /[\r\n]/.test(blank);
  if (double !== undefined) return REQUOTES.test(double);
  if (text === undefined) return false;
  return REQUOTES.test(text) || (text.endsWith("$") && next === "'");
}

/** The words and separators of a command line, and an unclosed quote if any. */
function tokenize(command: string): {
  tokens: Token[];
  unclosed: string | null;
} {
  const tokens: Token[] = [];
  let unclosed: string | null = null;
  let word = "";
  const endWord = () => {
    if (word !== "") tokens.push({ word });
    word = "";
  };
  for (const [
    ,
    blank,
    separator,
    single,
    singleEnd,
    double,
    doubleEnd,
    text,
  ] of command.matchAll(PIECE)) {
    if (blank !== undefined || separator !== undefined) endWord();
    if (separator !== undefined) tokens.push({ separator });
    if (singleEnd === "") unclosed ??= "'";
    if (doubleEnd === "") unclosed ??= '"';
    word += single ?? double ?? text ?? "";
  }
  endWord();
  return { tokens, unclosed };
}

/** Shell syntax in one piece of a command line that this scan does not parse. */
function unsupportedPiece(
  text: string | undefined,
  double: string | undefined,
  wordStart: boolean,
): string | null {
  if (double !== undefined)
    return /[$`]/.test(double) ? `an expansion inside "${double}"` : null;
  if (text === undefined) return null;
  if (wordStart && text.startsWith("#")) return "a comment";
  if (text === "&") return "a background `&`";
  return PLAIN.test(text) ? null : `\`${text}\``;
}

/**
 * Each piece of a command line's shell syntax beyond plain words, quotes and
 * separators, and whether any piece changes how the rest of the line's quotes
 * are read. The pieces are read in order, so every piece before the first
 * such syntax is read as a shell reads it, quoted or not.
 */
function unsupportedPieces(command: string): {
  found: string[];
  requoted: boolean;
} {
  const found: string[] = [];
  let requoted = false;
  let wordStart = true;
  for (const match of command.matchAll(PIECE)) {
    const [whole, blank, separator, , , double, , text] = match;
    const piece = unsupportedPiece(text, double, wordStart);
    if (piece !== null) found.push(piece);
    const next = command.charAt(match.index + whole.length);
    requoted ||= piece === "a comment" || requotes(blank, double, text, next);
    wordStart = blank !== undefined || separator !== undefined;
  }
  return { found, requoted };
}

/**
 * The first shell syntax beyond plain words, quotes and separators, if any,
 * and whether the line's syntax changes how its quotes are read.
 */
function unsupportedSyntax(
  command: string,
): Pick<Scan, "unsupported" | "requoted"> {
  const { found: pieces, requoted } = unsupportedPieces(command);
  if (/[\r\n]/.test(command)) return { unsupported: "a line break", requoted };
  if (command.includes("\\"))
    return { unsupported: "a backslash escape", requoted };
  return { unsupported: pieces[0] ?? null, requoted };
}

/**
 * A command line split into segments of words, why a shell would refuse it,
 * the syntax it uses that this scan does not parse, and whether that syntax
 * changes how its quotes are read (which makes `syntax` a guess too).
 */
interface Scan {
  segments: string[][];
  syntax: string | null;
  unsupported: string | null;
  requoted: boolean;
}

/** Split a command line on `&&`, `||`, `;` and `|` outside quotes, then into words. */
function scan(command: string): Scan {
  const { tokens, unclosed } = tokenize(command);
  const segments: string[][] = [];
  let syntax: string | null =
    unclosed === null ? null : `has an unclosed ${unclosed} quote`;
  let words: string[] = [];
  for (const token of tokens) {
    if ("word" in token) words.push(token.word);
    else if (words.length > 0) segments.push(words);
    else if (token.separator !== ";")
      syntax ??= `has \`${token.separator}\` with no command before it`;
    if ("separator" in token) words = [];
  }
  if (words.length > 0) segments.push(words);
  const last = tokens.at(-1);
  if (last !== undefined && "separator" in last && last.separator !== ";")
    syntax ??= `ends with \`${last.separator}\` and no command after it`;
  if (segments.length === 0) syntax ??= "runs no command";
  return { segments, syntax, ...unsupportedSyntax(command) };
}

/** Split a command line on `&&`, `||`, `;` and `|` outside quotes, then into words. */
export function commandSegments(command: string): string[][] {
  return scan(command).segments;
}

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

/**
 * The makefile `make` would read, by its exact name: listed rather than
 * tested with `existsSync`, which on a case-insensitive file system finds
 * `makefile` when the file is `Makefile`.
 */
function makefileOf(root: string): string | undefined {
  const names = new Set(readdirSync(root));
  return ["GNUmakefile", "makefile", "Makefile"].find((f) => names.has(f));
}
const SCRIPT_FILE = /\.(m?[jt]s|cjs|tsx|jsx)$/;

type Problem = { severity: "error" | "warning" | "info"; message: string };

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Drop leading `NAME=value` words. */
function withoutAssignments(words: string[]): string[] {
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i] ?? "")) i++;
  return words.slice(i);
}

/**
 * The words that run, without leading assignments or an `env` or `exec`
 * prefix; the prefix and its option instead when it takes one, since an
 * option may take a value and what it runs is then unknown here.
 */
function commandWords(segment: string[]): string[] | string {
  const words = withoutAssignments(segment);
  if (words[0] !== "env" && words[0] !== "exec") return words;
  if (words[1]?.startsWith("-")) return `${words[0]} ${words[1]}`;
  return commandWords(words.slice(1));
}

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
  const path = isAbsolute(name) ? name : join(ctx.root, name);
  if (!existsSync(path))
    return [{ severity: "error", message: `${name} does not exist` }];
  const stat = statSync(path);
  if (!stat.isFile())
    return [{ severity: "error", message: `${name} is not a file` }];
  if (direct && process.platform !== "win32" && (stat.mode & 0o111) === 0)
    return [{ severity: "error", message: `${name} is not executable` }];
  const relative = isAbsolute(name)
    ? null
    : normalize(name).replaceAll("\\", "/");
  if (
    relative !== null &&
    !relative.startsWith("..") &&
    !ctx.tracked.has(relative)
  )
    return [
      {
        severity: "warning",
        message: `${name} is not tracked, so a fresh clone lacks it`,
      },
    ];
  return [];
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
  if (existsSync(isAbsolute(value) ? value : join(root, value))) return [];
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
  return findings;
}

/**
 * Run each skill's own validation of the file, so the audit refuses what they
 * refuse. Each validator gets the repository's file alone: the user layer and
 * the environment belong to whoever runs the audit, not to the repository.
 */
function skillValidation(config: Config, path: string): Finding[] {
  const findings: Finding[] = [];
  const attempt = (skill: string, check: () => unknown) => {
    try {
      check();
    } catch (e) {
      findings.push({
        id: `rejected:${skill}`,
        severity: "error",
        message: `${skill} refuses the file: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };
  attempt("do-item (pull-request policy)", () => parsePrPolicy(config));
  attempt("do-item (tracker)", () => {
    refuseRenamedSection(config);
    parseTrackerConfig(config);
  });
  attempt("resolve-review-comments", () => parseReviewConfig(config.review));
  attempt("adr", () => adrConfig(path));
  return findings;
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
 * audit judges the repository's file alone, but the skills on this machine
 * also read the user file and the environment.
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
      message: `on this machine ${path} sets ${filled.join(", ")}, which the repository's file leaves unset: the skills here use those values, others get the defaults. The audit judged the repository's file alone`,
    });
  const variables = Object.keys(process.env).filter((k) =>
    k.startsWith(ENV_PREFIX),
  );
  if (variables.length > 0)
    findings.push({
      id: "fact:environment-layer",
      severity: "info",
      message: `${variables.join(", ")} set values for this run only; the audit ignored them`,
    });
  return findings;
}

interface Pull {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  statusCheckRollup?: { name?: string; context?: string }[];
  reviews?: { author?: { login?: string } }[];
  comments?: { author?: { login?: string } }[];
}

const RECENT = 20;
const AUTOMATION =
  /^(dependabot|renovate|github-actions|codecov|netlify|vercel)/i;
const normalLogin = (login: string) =>
  login.replace(/\[bot\]$/, "").toLowerCase();

interface ForgeRepo {
  nameWithOwner: string;
  defaultBranchRef?: { name?: string };
  deleteBranchOnMerge?: boolean;
}

/**
 * Add the checks classic branch protection requires to `required`. False
 * when whether the branch is protected could not be read.
 */
function classicProtection(
  slug: string,
  base: string,
  root: string,
  required: Set<string>,
  report: FitReport,
): boolean {
  const protection = run(
    "gh",
    ["api", `repos/${slug}/branches/${base}/protection`],
    { cwd: root },
  );
  if (protection.code !== 0) {
    if (/not protected/i.test(protection.stderr)) return true;
    // Reading protection needs admin rights; the branch itself tells any
    // reader whether it is protected at all.
    const branch = ghJson(["api", `repos/${slug}/branches/${base}`], root);
    return (
      branch.ok && (branch.value as { protected?: unknown }).protected === false
    );
  }
  let p: unknown;
  try {
    p = JSON.parse(protection.stdout);
  } catch (error) {
    report.facts.branch_protection_error = String(error);
    return false;
  }
  if (!isRecord(p)) return false;
  for (const check of protectionChecks(p.required_status_checks))
    required.add(check);
  const reviews = isRecord(p.required_pull_request_reviews)
    ? p.required_pull_request_reviews.required_approving_review_count
    : undefined;
  report.facts.required_reviews = String(
    typeof reviews === "number" ? reviews : 0,
  );
  return true;
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
 * Add the checks the branch's rulesets require to `required`. False when
 * the rulesets could not be read.
 */
function rulesetChecks(
  slug: string,
  base: string,
  root: string,
  required: Set<string>,
): boolean {
  const rules = ghJson(["api", `repos/${slug}/rules/branches/${base}`], root);
  if (!rules.ok || !Array.isArray(rules.value)) return false;
  for (const rule of rules.value as {
    type?: string;
    parameters?: { required_status_checks?: { context: string }[] };
  }[])
    if (rule.type === "required_status_checks")
      for (const c of rule.parameters?.required_status_checks ?? [])
        required.add(c.context);
  return true;
}

/** The checks the integration branch requires: classic protection and rulesets both count. */
function requiredChecks(
  slug: string,
  base: string,
  root: string,
  report: FitReport,
): { required: Set<string>; findings: Finding[] } {
  const required = new Set<string>();
  const classicKnown = classicProtection(slug, base, root, required, report);
  const rulesKnown = rulesetChecks(slug, base, root, required);
  const known = classicKnown && rulesKnown;
  if (!known) {
    report.facts.branch_protection =
      "unchecked: protection or rulesets could not be read";
    return { required, findings: [] };
  }
  if (required.size > 0) {
    report.facts.branch_protection = `requires ${[...required].join(", ")}`;
    return { required, findings: [] };
  }
  report.facts.branch_protection = "requires no checks";
  return {
    required,
    findings: [
      {
        id: "fact:no-required-checks",
        severity: "info",
        message: `${base} requires no status checks: a failing gate does not block a merge`,
      },
    ],
  };
}

/** The last merged pull requests into `base`, or null when unreadable. */
function mergedPulls(base: string, root: string): Pull[] | null {
  const merged = ghJson(
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--base",
      base,
      "--limit",
      String(RECENT),
      "--json",
      "number,title,headRefName,baseRefName,statusCheckRollup,reviews,comments",
    ],
    root,
  );
  return merged.ok && Array.isArray(merged.value)
    ? (merged.value as Pull[])
    : null;
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

/** How many of the pull requests each login reviewed or commented on. */
function reviewerCounts(pulls: Pull[]): Map<string, number> {
  const authors = new Map<string, number>();
  for (const p of pulls) {
    const seen = new Set(
      [...(p.reviews ?? []), ...(p.comments ?? [])]
        .map((r) => r.author?.login)
        .filter((l): l is string => typeof l === "string")
        .map(normalLogin),
    );
    for (const login of seen) authors.set(login, (authors.get(login) ?? 0) + 1);
  }
  return authors;
}

/** Whether a login looks like a review bot that reviewed often enough to list. */
function likelyReviewBot(login: string, count: number): boolean {
  return (
    /(bot|review|ai)$|^ai[-_]|review/i.test(login) &&
    !AUTOMATION.test(login) &&
    count >= 2
  );
}

/**
 * The login the review skills match for `login`: the forge's GraphQL drops a
 * bot's `[bot]` suffix, and the skills match `review.bots` against the REST
 * login, which carries it. The suffix is added only when the forge confirms
 * the account is a bot, and the login stays as it is only when the forge says
 * there is no such bot; any other answer leaves it unknown (`null`).
 */
function restLogin(login: string, root: string): string | null {
  const user = ghJson(["api", `users/${login}[bot]`], root);
  if (!user.ok) return /\bHTTP 404\b/.test(user.reason) ? login : null;
  const type =
    typeof user.value === "object" && user.value !== null
      ? (user.value as { type?: unknown }).type
      : undefined;
  return type === "Bot" ? `${login}[bot]` : null;
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
function reviewBotFindings(
  config: Config,
  pulls: Pull[],
  root: string,
  report: FitReport,
): Finding[] {
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
  const likely = [...authors].filter(([login, count]) =>
    likelyReviewBot(login, count),
  );
  const bots: Suggestion[] = [];
  const unchecked: Finding[] = [];
  for (const [login, count] of likely) {
    const evidence = `${login} reviewed ${count} of the last ${pulls.length} merged pull requests`;
    const rest = restLogin(login, root);
    if (rest === null)
      unchecked.push({
        id: `unchecked:review.bots:${login}`,
        severity: "info",
        message: `${evidence}, but whether it is a bot could not be read, so the login review.bots needs is unchecked: no value is suggested`,
      });
    else
      bots.push({
        field: "review.bots",
        key: login,
        value: [rest],
        evidence,
        message: `${evidence}: list it in review.bots so the review skills work its threads`,
      });
  }
  return [...findings, ...offer(report, bots), ...unchecked];
}

/** The issue key a pull request's title or head branch carries, if any. */
function issueKeyOf(pull: Pull): string | undefined {
  const match =
    /\b([A-Z][A-Z0-9]+)-\d+\b/.exec(pull.title) ??
    /^(?:[a-z]+\/)?([a-z][a-z0-9]*)-\d+-/.exec(pull.headRefName);
  return match?.[1]?.toUpperCase();
}

/** With no tracker team set, the team most recent pull requests name. */
function trackerTeamSuggestion(config: Config, pulls: Pull[]): Suggestion[] {
  if (at(config, "issue_tracker.team") !== undefined) return [];
  const keys = new Map<string, number>();
  for (const p of pulls) {
    const key = issueKeyOf(p);
    if (key) keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  const [team, count] = [...keys].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!team || !count || count < Math.max(3, pulls.length / 3)) return [];
  const evidence = `${count} of the last ${pulls.length} merged pull requests carry ${team}-<n> issue keys`;
  return [
    {
      field: "issue_tracker.team",
      value: team,
      evidence,
      message: `${evidence}: set issue_tracker.team: ${team} so the skills recognise them`,
    },
  ];
}

/** What the recent merged pull requests show: required checks, reviewers, the tracker team. */
function mergedPullFindings(
  config: Config,
  root: string,
  base: string,
  required: Set<string>,
  report: FitReport,
): Finding[] {
  const pulls = mergedPulls(base, root);
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
    ...reviewBotFindings(config, pulls, root, report),
    ...offer(report, trackerTeamSuggestion(config, pulls)),
  ];
}

/** Whether the open pull requests and the repository fit `pull_requests.stacking`. */
function stackingFindings(
  config: Config,
  root: string,
  base: string,
  repo: ForgeRepo,
  report: FitReport,
): Finding[] {
  const open = ghJson(
    [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,baseRefName",
    ],
    root,
  );
  if (!open.ok || !Array.isArray(open.value))
    return [
      {
        id: "unchecked:open-pulls",
        severity: "info",
        message: "open pull requests could not be read: stacking is unchecked",
      },
    ];
  const findings: Finding[] = [];
  const stacked = (
    open.value as { number: number; baseRefName: string }[]
  ).filter((p) => p.baseRefName !== base);
  report.facts.stacked_open_pulls = String(stacked.length);
  const declaredStacking = at(config, "pull_requests.stacking");
  const stacking =
    typeof declaredStacking === "string" ? declaredStacking : "none";
  if (stacking === "none" && stacked.length > 0)
    findings.push({
      id: "contradiction:pull_requests.stacking",
      severity: declaredStacking === undefined ? "suggestion" : "warning",
      message: `${stacked.length} open pull request(s) target another branch than ${base} (${stacked
        .slice(0, 5)
        .map((p) => `#${p.number} → ${p.baseRefName}`)
        .join(", ")}), but pull_requests.stacking is ${
        declaredStacking === undefined ? "unset (none)" : "none"
      }: declare native or branch, or stop stacking`,
    });
  if (stacking === "branch" && repo.deleteBranchOnMerge === false)
    findings.push({
      id: "contradiction:delete-branch-on-merge",
      severity: "warning",
      message:
        "pull_requests.stacking is branch, but the repository keeps head branches after merging, so GitHub does not retarget the layer above a merged one",
    });
  return findings;
}

/** Configured pull-request labels the repository does not have. */
function labelFindings(config: Config, root: string, slug: string): Finding[] {
  const labels = texts(at(config, "pull_requests.labels"));
  if (labels.length === 0) return [];
  const list = ghJson(
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

/** The integration branch: the declared or derived one, else the forge's default. */
function forgeBase(repo: ForgeRepo, report: FitReport): string | null {
  const base =
    report.facts.integration_branch ?? repo.defaultBranchRef?.name ?? null;
  if (base !== null && !report.facts.integration_branch) {
    report.facts.integration_branch = base;
    report.facts.integration_branch_source = "the forge's default branch";
  }
  return base;
}

function forgeChecks(
  config: Config,
  root: string,
  report: FitReport,
): Finding[] {
  const view = ghJson(
    [
      "repo",
      "view",
      "--json",
      "nameWithOwner,defaultBranchRef,deleteBranchOnMerge",
    ],
    root,
  );
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
  const repo = view.value as ForgeRepo;
  const slug = repo.nameWithOwner;
  report.facts.repository = slug;
  const base = forgeBase(repo, report);
  if (base === null) return [];
  const { required, findings } = requiredChecks(slug, base, root, report);
  return [
    ...findings,
    ...mergedPullFindings(config, root, base, required, report),
    ...stackingFindings(config, root, base, repo, report),
    ...labelFindings(config, root, slug),
  ];
}

async function trackerCheck(config: Config): Promise<Finding[]> {
  const team = at(config, "issue_tracker.team");
  if (typeof team !== "string") return [];
  try {
    const tracker = openTracker(parseTrackerConfig(config));
    const probe = tracker.getIssue(`${team}-1`);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("no answer within 30 seconds")),
        30_000,
      ).unref(),
    );
    await Promise.race([probe, timeout]);
    return [];
  } catch (e) {
    return [
      {
        id: "derivation:issue_tracker",
        severity: "error",
        message: `the ${String(at(config, "issue_tracker.adapter") ?? "linear")} tracker cannot be reached: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
}

/** A tracked file named like a change-area catalog, when none is configured. */
function catalogSuggestion(config: Config, files: string[]): Suggestion[] {
  if (at(config, "drive.change_areas_catalog") !== undefined) return [];
  const catalog = files.find(
    (f) =>
      /(^|\/)change[-_]?areas?\.ya?ml$/i.test(f) &&
      !/(^|\/)(fixtures?|templates?)\//.test(f),
  );
  if (catalog === undefined) return [];
  return [
    {
      field: "drive.change_areas_catalog",
      value: catalog,
      evidence: `${catalog} is tracked and named like a change-area catalog`,
      message: `${catalog} looks like a change-area catalog: set drive.change_areas_catalog to it so reviews and agent routing use it`,
    },
  ];
}

/** A command that runs the repository's checks, and what shows it. */
type Gate = { command: string; evidence: string };

/** The package script that runs the repository's checks, with its runner. */
function scriptGate(root: string): Gate | null {
  const scripts = packageScripts(root) ?? {};
  const name = ["gates", "check", "ci", "verify", "validate", "test"].find(
    (n) => Object.hasOwn(scripts, n),
  );
  if (name === undefined) return null;
  const found = detectPackageManager(root).found;
  const manager = found?.name ?? "npm";
  const runner = found
    ? `, and ${found.lockfile} makes ${manager} its package manager`
    : "";
  return {
    command: `${manager} run ${name}`,
    evidence: `package.json defines a "${name}" script${runner}`,
  };
}

/** The make target that runs the repository's checks. */
function makeGate(root: string): Gate | null {
  const makefile = makefileOf(root);
  if (makefile === undefined) return null;
  const text = readFileSync(join(root, makefile), "utf8");
  const target = ["gates", "check", "ci", "verify"].find((t) =>
    new RegExp(`^${t}\\s*:`, "m").test(text),
  );
  if (target === undefined) return null;
  return {
    command: `make ${target}`,
    evidence: `${makefile} defines a "${target}" target`,
  };
}

/** With no gate command set, the one the repository's shape names. */
function gateFindings(
  config: Config,
  root: string,
  report: FitReport,
): Finding[] {
  if (at(config, "gates.command") !== undefined) return [];
  const gate = scriptGate(root) ?? makeGate(root);
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
    {
      field: "gates.command",
      value: gate.command,
      evidence: gate.evidence,
      message: `set gates.command: ${gate.command}, the repository's whole local check, so the review and CI skills run it before every push`,
    },
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
    ...gateFindings(config, root, report),
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
  const head = run(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    {
      cwd: root,
    },
  );
  const name = head.stdout.trim();
  if (head.code === 0 && name.startsWith("origin/")) {
    report.facts.integration_branch = name.slice("origin/".length);
    report.facts.integration_branch_source = "origin/HEAD";
  }
  return [];
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
  if (!existsSync(recordPath)) return refs;
  const record = parseRecord(readFileSync(recordPath, "utf8"), recordPath);
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
    report.findings.push(...checkConfig(config, schema));
    report.findings.push(...skillValidation(config, opts.file));
    report.findings.push(...crossFieldRules(config));
    report.findings.push(...derivations(config, schema, opts.root));
  } else
    report.findings.push({
      id: "missing-file",
      severity: "info",
      message: `no ${OVERLAY_RELPATH}: drive-pr, the pull-request policy and the procedure skills run on their defaults; resolve-review-comments and do-item's tracker scripts refuse to run`,
    });
  report.findings.push(...machineLayers(config, schema));
  const files = trackedFiles(opts.root);
  report.findings.push(...integrationBranch(config, opts.root, report));
  if (!opts.offline) {
    report.findings.push(...forgeChecks(config, opts.root, report));
    report.findings.push(...(await trackerCheck(config)));
  } else
    report.findings.push({
      id: "unchecked:offline",
      severity: "info",
      message:
        "offline: branch protection, required checks, pull requests, labels and the tracker are unchecked",
    });
  if (report.facts.integration_branch === undefined)
    report.findings.push(unknownIntegrationBranch(opts.root, report));
  report.findings.push(...suggestions(config, opts.root, files, report));
  applyDeclines(report, opts.recordPath);
  const draft = draftConfig(
    report.suggestions,
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
