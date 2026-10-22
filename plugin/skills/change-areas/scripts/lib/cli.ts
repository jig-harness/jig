/**
 * The command lines of the change-area skill, as functions a composer calls.
 *
 * A composer is a repository's own small script that runs these with its
 * own values: extra catalog fields, a default since-ref, extra GitHub
 * outputs, its own validation plan, the lines around its review table.
 * `runCli` and `runCheck` return the exit code and never exit the process;
 * the entry scripts in `scripts/` map it to the process's exit.
 *
 * Exit codes: 0 done; 1 the catalog breaks an invariant (`runCheck` only);
 * 2 a usage error, or a catalog that cannot be read or is invalid. A git
 * failure throws, so a resolution that cannot be made never passes.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Defect } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import {
  configSource,
  consumerRoot,
  readConfig,
} from "../../../../shared/consumer.ts";
import {
  type Area,
  type Catalog,
  CatalogError,
  type FieldExtensions,
  loadCatalog,
  readCatalogFile,
  validateCatalog,
} from "./catalog.ts";
import {
  type CheckContext,
  checkCatalog,
  graphProblems,
  outputNameProblems,
  repositoryFiles,
} from "./check.ts";
import {
  type ResolutionContext,
  type ReviewTableOptions,
  ValidationPlanError,
  toDornyFilter,
  toGhaOutputs,
  toJson,
  toPostDeployChecklist,
  toReviewGateTable,
  type ValidationPlan,
} from "./emit.ts";
import {
  applyImpliedClosure,
  changedFilesFromGit,
  changedFilesFromWorktree,
  GitContextError,
  GitError,
  type GitEvent,
  type GitRunner,
  matchSeedAreas,
} from "./resolve.ts";

/** What a composer supplies to `runCli`. */
export interface CliOptions {
  /** The catalog when `--catalog` is not given. */
  catalogPath?: string;
  /** Fields the composer's catalog adds. */
  fields?: FieldExtensions;
  /** Values the command line falls back to. */
  defaults?: { since?: string };
  /** Lines appended to the GitHub outputs. */
  ghaOutputs?: (ctx: ResolutionContext) => string[];
  /** The validation plan, replacing the default one. */
  validation?: (ctx: ResolutionContext) => ValidationPlan;
  /** The lines around the review-gate table. */
  reviewTable?: ReviewTableOptions;
  /** git, for tests. */
  git?: GitRunner;
}

/** What a composer supplies to `runCheck`. */
export interface CheckOptions {
  catalogPath?: string;
  fields?: FieldExtensions;
  /** More invariants, reported after the generic ones. */
  checks?: (catalog: Catalog, ctx: CheckContext) => string[];
}

const FORMATS = [
  "gha",
  "dorny",
  "json",
  "checklist",
  "review-table",
  "all",
] as const;
type Format = (typeof FORMATS)[number];
const EVENTS: readonly GitEvent[] = [
  "push",
  "pull_request",
  "workflow_dispatch",
];
const NO_ACTIONS = "_(No post-deploy actions required for this changeset.)_";

/** A command line that cannot be run as written: exit 2. */
class UsageError extends Error {}

interface Args {
  worktree?: boolean;
  files?: string;
  /** `--files` holds NUL-separated paths (`git … -z`). */
  nul?: boolean;
  base?: string;
  before?: string;
  event?: GitEvent;
  head?: string;
  since?: string;
  format: Format;
  output?: string;
  /** With `--format json`: the GitHub outputs' file too; `""` is `$GITHUB_OUTPUT`. */
  outputGha?: string;
  /** With `--format json`: no validation plan (`validation: null`). */
  noValidation?: boolean;
  areaPaths?: string;
  catalog?: string;
  help?: boolean;
}

const oneOf = <T extends string>(
  flag: string,
  value: string,
  allowed: readonly T[],
): T => {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(
    `invalid ${flag} "${value}" (expected ${allowed.join(" | ")})`,
  );
};

/** The flags that take a value, and where each puts it. */
const VALUE_FLAGS: Record<string, (args: Args, value: string) => void> = {
  "--files": (a, v) => {
    a.files = v;
  },
  "--base": (a, v) => {
    a.base = v;
  },
  "--before": (a, v) => {
    if (v === "")
      throw new UsageError(
        "--before needs a commit; leave it out to read the push event's",
      );
    a.before = v;
  },
  "--event": (a, v) => {
    a.event = oneOf("--event", v, EVENTS);
  },
  "--head": (a, v) => {
    a.head = v;
  },
  "--since": (a, v) => {
    a.since = v;
  },
  "--format": (a, v) => {
    a.format = oneOf("--format", v, FORMATS);
  },
  "--output": (a, v) => {
    a.output = v;
  },
  "--area-paths": (a, v) => {
    a.areaPaths = v;
  },
  "--catalog": (a, v) => {
    a.catalog = v;
  },
};

/** The flags that take no value. */
const SWITCHES: Record<string, (args: Args) => void> = {
  "--worktree": (a) => {
    a.worktree = true;
  },
  "-z": (a) => {
    a.nul = true;
  },
  "--null": (a) => {
    a.nul = true;
  },
  "--no-validation": (a) => {
    a.noValidation = true;
  },
  "-h": (a) => {
    a.help = true;
  },
  "--help": (a) => {
    a.help = true;
  },
};

/** The flags whose value may be left out, and where each puts it (`""` when left out). */
const OPTIONAL_FLAGS: Record<string, (args: Args, value: string) => void> = {
  "--output-gha": (a, v) => {
    a.outputGha = v;
  },
};

/** The flags one command line reads. */
interface FlagSpec {
  values: typeof VALUE_FLAGS;
  switches: typeof SWITCHES;
  optional: typeof OPTIONAL_FLAGS;
}

const RESOLVE_FLAGS: FlagSpec = {
  values: VALUE_FLAGS,
  switches: SWITCHES,
  optional: OPTIONAL_FLAGS,
};

/** `record[key]` when it is the record's own entry, else `undefined`. */
const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** Read the flag at `argv[i]` into `args`; returns how many arguments it took. */
function readFlag(
  argv: string[],
  i: number,
  args: Args,
  spec: FlagSpec,
): number {
  const arg = argv[i] as string;
  const next = argv[i + 1];
  const value = own(spec.values, arg);
  if (value) {
    if (next === undefined) throw new UsageError(`missing value for ${arg}`);
    value(args, next);
    return 2;
  }
  const optional = own(spec.optional, arg);
  if (optional) {
    const given = next !== undefined && !next.startsWith("-");
    optional(args, given ? next : "");
    return given ? 2 : 1;
  }
  const toggle = own(spec.switches, arg);
  if (!toggle) throw new UsageError(`unknown argument: ${arg}`);
  toggle(args);
  return 1;
}

/** `argv` read against `spec`. */
function parseArgs(argv: string[], spec = RESOLVE_FLAGS): Args {
  const args: Args = { format: "json" };
  for (let i = 0; i < argv.length; ) i += readFlag(argv, i, args, spec);
  if (args.noValidation && args.format !== "json" && args.format !== "all")
    throw new UsageError(
      `--no-validation applies to --format json or all, not ${args.format}`,
    );
  return args;
}

const HELP = [
  "Usage: bun <skill-dir>/scripts/resolve.ts [options]",
  "",
  "  --worktree             Include tracked and untracked workspace changes; requires --base <ref>",
  "  --files <path|->       Changed files, one per line, instead of git; - reads stdin",
  "  -z, --null             --files is NUL-separated (git diff -z --name-only), for any file name",
  "  --base <ref>           Pull request base branch (origin/<ref>...<head>); implies --event pull_request",
  "  --before <sha>         With push: the commit the push moved from (default: the push event's before)",
  "  --event <name>         push | pull_request | workflow_dispatch (default: $GITHUB_EVENT_NAME, else push)",
  "  --head <ref>           Commit to resolve (default: HEAD)",
  "  --since <ref>          With workflow_dispatch: the last verified commit; the gap since it is resolved",
  "  --format <format>      json | gha | dorny | checklist | review-table | all (default: json)",
  "  --output <path>        Write to a file (default: stdout; gha appends to $GITHUB_OUTPUT when set)",
  "  --output-gha [path]    With json: also append the GitHub outputs to <path> (default: $GITHUB_OUTPUT)",
  "  --no-validation        With json: plan no validation (validation: null), for a catalog read only to classify or route reviews",
  "  --area-paths <area>    Print one area's paths, one per line",
  "  --catalog <path>       The catalog (default: drive.change_areas_catalog in the Jig configuration)",
].join("\n");

/** The consumer's `drive.change_areas_catalog`, or `undefined` when unset. */
function configuredCatalog(): unknown {
  try {
    const drive = readConfig().drive;
    return isRecord(drive) ? drive.change_areas_catalog : undefined;
  } catch (err) {
    throw new UsageError(
      `the Jig configuration cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The catalog to read: `--catalog`, else the composer's, else the
 * consumer's `drive.change_areas_catalog`, resolved against its root.
 */
export function catalogPath(
  flag: string | undefined,
  fallback?: string,
): string {
  const explicit = flag ?? fallback;
  if (explicit !== undefined) return explicit;
  const configured = configuredCatalog();
  if (configured === undefined || configured === null)
    throw new UsageError(
      "no change-area catalog: pass --catalog <path> or set drive.change_areas_catalog in .config/jig.yaml",
    );
  if (typeof configured !== "string" || configured.trim() === "")
    throw new UsageError(
      `drive.change_areas_catalog must be a path: ${configSource("drive.change_areas_catalog")}`,
    );
  return isAbsolute(configured) ? configured : join(consumerRoot(), configured);
}

/**
 * The changed files of a list: NUL-separated with `nul`, else one per line.
 * A name is kept byte for byte (its spaces are part of it); only a line's
 * `\r` ending is dropped. A line git quoted (`"src/a\"b.ts"`, which it does
 * for a name holding a quote, a backslash or a control character) names no
 * file and is refused rather than matched as written: `-z` reads any name.
 */
function readFileList(source: string, nul = false): string[] {
  if (source === "")
    throw new UsageError("--files needs a path, or - for standard input");
  let text: string;
  try {
    text = readFileSync(source === "-" ? 0 : source, "utf8");
  } catch (err) {
    throw new UsageError(
      `--files ${source} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (nul) return text.split("\0").filter((p) => p.length > 0);
  const files = text
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .filter((l) => l.length > 0);
  const quoted = files.find(
    (f) => f.length > 1 && f.startsWith('"') && f.endsWith('"'),
  );
  if (quoted !== undefined)
    throw new UsageError(
      `--files holds ${quoted}, a path git quoted; list the files NUL-separated (git diff -z --name-only) and pass -z`,
    );
  return files;
}

function write(
  content: string,
  target: string | undefined,
  append = false,
): void {
  if (!target) process.stdout.write(`${content}\n`);
  else if (append) appendFileSync(target, `${content}\n`);
  else writeFileSync(target, content);
}

/** Print a usage or catalog failure and give its exit code, or rethrow. */
function failure(err: unknown, catalog?: string): number {
  if (
    err instanceof UsageError ||
    err instanceof GitContextError ||
    err instanceof CatalogError
  ) {
    console.error(`change-areas: ${err.message}`);
    return 2;
  }
  // A defect in the composer is not the catalog's fault.
  if (catalog !== undefined && !(err instanceof Defect)) {
    console.error(
      `change-areas: the catalog ${catalog} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }
  throw err;
}

/** Workspace mode has one base and cannot mix event or saved-list inputs. */
function workspaceBase(args: Args): string {
  const conflicting = [
    args.files !== undefined,
    args.nul,
    args.event,
    args.head,
    args.since,
    args.before,
  ].some(Boolean);
  if (!args.base || conflicting)
    throw new UsageError(
      "--worktree requires --base <ref> and cannot be combined with file lists or event options",
    );
  return args.base;
}

/** The changed files: the list given, else git's for the selected mode. */
function changedFilesOf(args: Args, options: CliOptions): string[] {
  if (args.worktree)
    return changedFilesFromWorktree(workspaceBase(args), options.git);
  if (args.files !== undefined) return readFileList(args.files, args.nul);
  if (args.nul) throw new UsageError("-z applies to --files only");
  const eventName = eventOf(args);
  return changedFilesFromGit(
    {
      eventName,
      baseRef: args.base ?? (process.env.GITHUB_BASE_REF || undefined),
      head: args.head,
      sinceRef: args.since ?? options.defaults?.since,
      beforeRef: beforeOf(args, eventName),
    },
    options.git,
  );
}

/** A push's before SHA: `--before`, else the push event's; none for another event. */
function beforeOf(args: Args, event: GitEvent | undefined): string | undefined {
  if ((event ?? "push") !== "push") return undefined;
  return args.before ?? pushEventBefore();
}

/**
 * The `before` SHA of the push event GitHub Actions is running for, from the
 * payload at `$GITHUB_EVENT_PATH`; `undefined` outside a push workflow. A
 * payload without a commit SHA there is refused rather than read as a push
 * with no before: that would narrow a multi-commit push to its tip. A push
 * that created its branch carries the all-zero SHA, which the git layer
 * reads as the tip alone.
 */
function pushEventBefore(): string | undefined {
  const path = process.env.GITHUB_EVENT_PATH;
  if (process.env.GITHUB_EVENT_NAME !== "push" || !path) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(
      `$GITHUB_EVENT_PATH ${path} cannot be read: ${err instanceof Error ? err.message : String(err)}; pass --before <sha>`,
    );
  }
  const before = isRecord(payload) ? payload.before : undefined;
  if (typeof before !== "string" || !COMMIT_SHA.test(before))
    throw new UsageError(
      `$GITHUB_EVENT_PATH ${path} is a push event without a commit SHA as \`before\` (found ${JSON.stringify(before) ?? "nothing"}); pass --before <sha>`,
    );
  return before;
}

/** A full commit SHA, SHA-1 or SHA-256. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The flags that name one event's diff, refused with another event rather
 * than ignored: a `--base` dropped from a push would narrow the diff the
 * caller asked for to its tip.
 */
function eventFlagProblem(args: Args): string | undefined {
  if (args.files !== undefined) return undefined;
  const event = eventOf(args) ?? "push";
  if (args.base !== undefined && event !== "pull_request")
    return `--base applies to pull_request, not --event ${event}`;
  if (args.before !== undefined && event !== "push")
    return `--before applies to push, not --event ${event}`;
  if (args.since !== undefined && event !== "workflow_dispatch")
    return `--since applies to workflow_dispatch, not --event ${event}`;
  return undefined;
}

/**
 * The event to take the diff for: `--event`, else `pull_request` with
 * `--base`, else `$GITHUB_EVENT_NAME`; unset means push. An event the
 * resolver has no diff for is refused rather than read as a push, whose
 * one-commit diff would under-report the change.
 */
function eventOf(args: Args): GitEvent | undefined {
  if (args.event) return args.event;
  if (args.base) return "pull_request";
  const name = process.env.GITHUB_EVENT_NAME;
  if (!name) return undefined;
  const event = EVENTS.find((e) => e === name);
  if (event === undefined)
    throw new UsageError(
      `$GITHUB_EVENT_NAME is "${name}", which has no diff here: pass --event (${EVENTS.join(" | ")}), --base <branch> or --files <list>`,
    );
  return event;
}

/** Print the projection `--format` asks for. */
function emit(args: Args, ctx: ResolutionContext, options: CliOptions): void {
  const gha = () => toGhaOutputs(ctx, options.ghaOutputs?.(ctx) ?? []);
  const json = () => toJson(ctx, args.noValidation ? null : options.validation);
  const checklist = () => toPostDeployChecklist(ctx) || NO_ACTIONS;
  if (args.format === "gha")
    write(gha(), args.output ?? process.env.GITHUB_OUTPUT, true);
  else if (args.format === "checklist") write(checklist(), args.output);
  else if (args.format === "all")
    write(
      [
        "=== gha ===",
        gha(),
        "",
        "=== dorny ===",
        toDornyFilter(ctx.catalog),
        "=== json ===",
        json(),
        "",
        "=== checklist ===",
        checklist(),
      ].join("\n"),
      args.output,
    );
  else {
    write(json(), args.output);
    // One git run for both: the JSON to its target, the outputs appended.
    if (args.outputGha !== undefined)
      write(gha(), args.outputGha || process.env.GITHUB_OUTPUT, true);
  }
}

/** The projections that read only the catalog; `false` for the others. */
function emitStatic(
  args: Args,
  catalog: Catalog,
  options: CliOptions,
): boolean {
  if (args.format !== "dorny" && args.format !== "review-table") return false;
  if (args.files)
    console.warn(
      `change-areas: --files is ignored with --format ${args.format}, a static projection`,
    );
  write(
    args.format === "dorny"
      ? toDornyFilter(catalog)
      : toReviewGateTable(catalog, options.reviewTable),
    args.output,
  );
  return true;
}

/** Resolve a change and print one or more projections of it. */
export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<number> {
  let args: Args;
  let path: string | undefined;
  let catalog: Catalog;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(HELP);
      return 0;
    }
    path = catalogPath(args.catalog, options.catalogPath);
    catalog = loadCatalog(path, options.fields);
    // A dangling, self or cyclic `impliedBy` would resolve without a word,
    // leaving an implied area unreached, and two areas sharing an output name
    // would hide one flag: refuse them like a schema problem.
    const graph = [...graphProblems(catalog), ...outputNameProblems(catalog)];
    if (graph.length > 0) throw new CatalogError(path, graph);
  } catch (err) {
    return failure(err, path);
  }
  if (args.areaPaths !== undefined) {
    if (!Object.hasOwn(catalog.areas, args.areaPaths)) {
      console.error(`change-areas: no area "${args.areaPaths}" in ${path}`);
      return 2;
    }
    write(
      (catalog.areas[args.areaPaths] as Area).paths.join("\n"),
      args.output,
    );
    return 0;
  }
  if (emitStatic(args, catalog, options)) return 0;
  let changedFiles: string[];
  try {
    const problem = eventFlagProblem(args);
    if (problem) throw new UsageError(problem);
    // Before anything is written: the outputs would otherwise land on
    // stdout behind the JSON and make it unparseable.
    if (args.outputGha === "" && !process.env.GITHUB_OUTPUT)
      throw new UsageError(
        "--output-gha without a path needs $GITHUB_OUTPUT; name the file",
      );
    changedFiles = changedFilesOf(args, options);
  } catch (err) {
    // A missing ref or file list is how the command was called; a git
    // failure is a resolution that could not be made, and throws.
    return failure(err);
  }
  const seed = matchSeedAreas(changedFiles, catalog);
  const resolved = applyImpliedClosure(seed, catalog);
  try {
    emit(args, { changedFiles, seed, resolved, catalog }, options);
  } catch (err) {
    if (!(err instanceof ValidationPlanError)) throw err;
    console.error(`change-areas: ${err.message}`);
    return 2;
  }
  return 0;
}

const CHECK_HELP = [
  "Usage: bun <skill-dir>/scripts/check.ts [--catalog <path>]",
  "",
  "Checks the catalog's schema and invariants: exit 0 valid, 1 a problem, 2 unreadable.",
  "  --catalog <path>   The catalog (default: drive.change_areas_catalog in the Jig configuration)",
].join("\n");

/** The schema's problems, then the invariants', generic and the composer's. */
function checkProblems(
  doc: unknown,
  path: string,
  options: CheckOptions,
): string[] {
  let catalog: Catalog;
  try {
    catalog = validateCatalog(doc, options.fields, path);
  } catch (err) {
    if (err instanceof CatalogError) return err.problems;
    throw err;
  }
  const root = consumerRoot();
  const ctx: CheckContext = { root, trackedFiles: repositoryFiles(root) };
  return [
    ...checkCatalog(catalog, ctx),
    ...(options.checks?.(catalog, ctx) ?? []),
  ];
}

/**
 * Check a catalog: its schema, the generic invariants against the
 * repository at the working directory's root, then the composer's own.
 */
export async function runCheck(
  argv: string[],
  options: CheckOptions = {},
): Promise<number> {
  const catalogFlags: FlagSpec = {
    values: {
      "--catalog": VALUE_FLAGS["--catalog"] as (a: Args, v: string) => void,
    },
    switches: {
      "-h": SWITCHES["-h"] as (a: Args) => void,
      "--help": SWITCHES["--help"] as (a: Args) => void,
    },
    optional: {},
  };
  let path: string | undefined;
  let doc: unknown;
  try {
    const args = parseArgs(argv, catalogFlags);
    if (args.help) {
      console.log(CHECK_HELP);
      return 0;
    }
    path = catalogPath(args.catalog, options.catalogPath);
    doc = readCatalogFile(path);
  } catch (err) {
    return failure(err, path);
  }
  let problems: string[];
  try {
    problems = checkProblems(doc, path, options);
  } catch (err) {
    // A repository whose files cannot be listed cannot be checked.
    if (!(err instanceof GitError)) throw err;
    console.error(
      `change-areas: the repository cannot be listed: ${err.message}`,
    );
    return 2;
  }
  for (const problem of problems) console.error(`${path}: ${problem}`);
  if (problems.length > 0) return 1;
  console.log(`change-areas: OK — ${path} is valid`);
  return 0;
}
