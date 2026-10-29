#!/usr/bin/env bun
/**
 * Classify every tracked file of the repository by area (what it is for),
 * kind (what it is), language and module, count its bytes and its lines
 * (blank, comment, code), and report the totals.
 *
 *   bun code-stats.ts                      terminal summary
 *   bun code-stats.ts --json               aggregates as JSON (schema code-stats/v1)
 *   bun code-stats.ts --html [out.html]    self-contained interactive report
 *   bun code-stats.ts --explain <path>     the rule behind each value of one file
 *   bun code-stats.ts --top N              modules in the terminal summary (15)
 *   bun code-stats.ts --include-vendored   count vendored files too
 *
 * Run from the repository it describes. Exit 0 on success, 1 when the report
 * cannot be made (a failed git call or classify command, a refused
 * configuration), 2 on a command line it cannot act on.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fail, runMain, shellQuote } from "../../../shared/cli.ts";
import {
  consumerRoot,
  readConfig,
  withSource,
} from "../../../shared/consumer.ts";
import { jsonReport, testRunnerSummary, total } from "./lib/aggregate.ts";
import {
  type AnalyzedFile,
  analyzeAll,
  analyzeFile,
  type Context,
} from "./lib/analyze.ts";
import { runClassifyCommand } from "./lib/classify-command.ts";
import {
  areaDescriptions,
  areaNames,
  type CodeStatsConfig,
  parseCodeStatsConfig,
} from "./lib/config.ts";
import { CONVENTIONS } from "./lib/conventions.ts";
import { CodeStatsError, UsageError } from "./lib/errors.ts";
import { explainJson, explainText } from "./lib/explain.ts";
import { listTracked, readAttributes, repositoryInfo } from "./lib/git.ts";
import { KINDS } from "./lib/model.ts";
import { detectModules } from "./lib/modules.ts";
import { renderHtmlReport } from "./lib/render-html.ts";
import { type RepoFiles, readTestRunners } from "./lib/test-runners/index.ts";
import { UnreadableError } from "./lib/test-runners/model.ts";
import {
  fmt,
  fmtBytes,
  terminalReport,
  useColour,
} from "./lib/render-terminal.ts";

const USAGE = `code-stats: classify and count the repository's tracked files.

Usage:
  bun code-stats.ts [--json | --html [out.html] | --explain <path> [--json]]
                    [--top N] [--include-vendored]

  --json              Print the aggregates as JSON
  --html [path]       Write a self-contained interactive HTML report
                      (default: .context/code-stats/code-stats.html)
  --explain <path>    Print each dimension of one tracked file and the rule
                      that set it
  --top N             Modules in the terminal summary (default 15)
  --include-vendored  Count vendored files, which are left out by default
  -h, --help          Show this help`;

export interface Options {
  mode: "terminal" | "json" | "html" | "explain";
  json: boolean;
  html: string | null;
  explain: string | null;
  top: number;
  includeVendored: boolean;
  help: boolean;
}

interface Draft extends Options {
  htmlSeen: boolean;
}

/** What each flag does to the options; how many following arguments it took. */
const FLAGS: Record<string, (o: Draft, next: string | undefined) => number> = {
  "-h": (o) => {
    o.help = true;
    return 0;
  },
  "--help": (o) => {
    o.help = true;
    return 0;
  },
  "--json": (o) => {
    o.json = true;
    return 0;
  },
  "--include-vendored": (o) => {
    o.includeVendored = true;
    return 0;
  },
  "--html": (o, next) => {
    o.htmlSeen = true;
    if (next === undefined || next.startsWith("--")) return 0;
    if (next.startsWith("-"))
      throw new UsageError(`--html takes a file path, not ${next}`);
    o.html = next;
    return 1;
  },
  "--explain": (o, next) => {
    if (next === undefined || next.startsWith("-"))
      throw new UsageError("--explain needs the path of a tracked file");
    o.explain = next;
    return 1;
  },
  "--top": (o, next) => {
    if (next === undefined || !/^[1-9][0-9]{0,5}$/.test(next))
      throw new UsageError("--top needs a whole number from 1 to 999999");
    o.top = Number(next);
    return 1;
  },
};

function modeOf(o: Draft): Options["mode"] {
  if (o.htmlSeen && (o.json || o.explain !== null))
    throw new UsageError("--html cannot be combined with --json or --explain");
  if (o.explain !== null) return "explain";
  if (o.htmlSeen) return "html";
  return o.json ? "json" : "terminal";
}

/** Parse the command line; a `UsageError` names what is wrong. */
export function parseArgs(args: readonly string[]): Options {
  const o: Draft = {
    mode: "terminal",
    json: false,
    html: null,
    explain: null,
    top: 15,
    includeVendored: false,
    help: false,
    htmlSeen: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const flag = Object.hasOwn(FLAGS, arg) ? FLAGS[arg] : undefined;
    if (!flag) throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    i += flag(o, args[i + 1]);
  }
  const { htmlSeen: _, ...options } = o;
  return { ...options, mode: modeOf(o) };
}

function loadConfig(): CodeStatsConfig {
  const values = readConfig();
  try {
    return parseCodeStatsConfig(values.code_stats);
  } catch (error) {
    throw new CodeStatsError(withSource(values, "code_stats", error).message, {
      cause: error,
    });
  }
}

/** A path given on the command line, as the tracked path it names. */
function trackedPath(root: string, given: string): string {
  const abs = isAbsolute(given) ? given : resolve(process.cwd(), given);
  // The file's own name is kept, so a tracked link is explained as itself.
  const file = join(realPath(dirname(abs)), basename(abs));
  return relative(realPath(root), file).split(sep).join("/");
}

/**
 * `path` with every symbolic link resolved, so a path through a linked
 * folder (`/tmp` on macOS) compares with the root; a missing file keeps its
 * name under its resolved folder.
 */
function realPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(realPath(parent), basename(path));
}

/**
 * The tracked files as the test-runner readers see them: regular files, read
 * as text or as bytes. A file the file system refuses to read is unreadable
 * configuration, reported beside the others rather than ending the run.
 */
function repoFiles(root: string, paths: readonly string[]): RepoFiles {
  const load = <T>(path: string, read: (abs: string) => T): T | null => {
    const abs = join(root, path);
    try {
      return lstatSync(abs, { throwIfNoEntry: false })?.isFile()
        ? read(abs)
        : null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "an I/O error";
      throw new UnreadableError(`could not be read (${code})`);
    }
  };
  return {
    paths,
    read: (path) => load(path, (abs) => readFileSync(abs, "utf8")),
    bytes: (path) => load(path, (abs) => readFileSync(abs)),
  };
}

type Ctx = Context & { paths: string[]; areas: string[] };

/** Read the configuration and everything git knows that every mode needs. */
async function prepare(): Promise<Ctx> {
  const root = consumerRoot();
  const config = loadConfig();
  const { paths, submodules } = await listTracked(root);
  const attributes = await readAttributes(root, paths);
  const areas = areaNames(config);
  const overrides = config.classifyCommand
    ? await runClassifyCommand(
        root,
        config.classifyCommand,
        paths,
        new Set(areas),
      )
    : new Map();
  const modules = detectModules(root, paths, config.modules);
  const runners = readTestRunners(repoFiles(root, paths));
  return {
    root,
    config,
    modules,
    attributes,
    submodules,
    overrides,
    runners,
    paths,
    areas,
  };
}

async function explain(o: Options, ctx: Ctx): Promise<number> {
  const path = trackedPath(ctx.root, o.explain as string);
  if (!ctx.paths.includes(path))
    throw new CodeStatsError(`${path} is not a tracked file`);
  const file = await analyzeFile(path, ctx);
  if (!file)
    throw new CodeStatsError(
      `${path} is tracked but missing from the working tree`,
    );
  process.stdout.write(
    o.json
      ? `${JSON.stringify(explainJson(file, o.includeVendored, ctx.runners.unreadable), null, 2)}\n`
      : explainText(file, o.includeVendored, ctx.runners.unreadable),
  );
  return 0;
}

/** What every report renders from. */
async function reportData(o: Options, ctx: Ctx) {
  const { files: analyzed, missing } = await analyzeAll(ctx.paths, ctx);
  const isVendored = (f: AnalyzedFile) => f.stats.kind === "vendored";
  const counted = analyzed
    .filter((f) => o.includeVendored || !isVendored(f))
    .map((f) => f.stats);
  const vendoredExcluded = total(
    o.includeVendored ? [] : analyzed.filter(isVendored).map((f) => f.stats),
  );
  const info = await repositoryInfo(ctx.root);
  return {
    // A one-shot command: the wall clock here is the report's timestamp.
    generatedAt: new Date().toISOString(),
    repository: info.name,
    commit: info.commit,
    branch: info.branch,
    areas: ctx.areas,
    areaDescriptions: areaDescriptions(ctx.config),
    defaultArea: ctx.config.defaultArea,
    kinds: KINDS,
    files: counted,
    vendoredExcluded,
    includeVendored: o.includeVendored,
    missing,
    testRunners: testRunnerSummary(ctx.runners),
  };
}

type Data = Awaited<ReturnType<typeof reportData>>;

async function writeHtml(o: Options, ctx: Ctx, data: Data): Promise<number> {
  const out = o.html
    ? resolve(process.cwd(), o.html)
    : join(ctx.root, ".context", "code-stats", "code-stats.html");
  const html = renderHtmlReport({
    ...data,
    vendoredExcluded: data.vendoredExcluded.files,
    conventions: CONVENTIONS.map(({ ecosystem, rule, kind }) => ({
      ecosystem,
      rule,
      kind,
    })),
  });
  mkdirSync(dirname(out), { recursive: true });
  const written = await Bun.write(out, html);
  const left = o.includeVendored
    ? ""
    : `, ${fmt(data.vendoredExcluded.files)} vendored left out`;
  process.stdout.write(
    `Wrote ${out} (${fmtBytes(written)}, ${fmt(data.files.length)} files${left})\n`,
  );
  return 0;
}

async function run(o: Options): Promise<number> {
  const ctx = await prepare();
  if (o.mode === "explain") return explain(o, ctx);
  if (o.mode === "terminal")
    process.stderr.write(`Scanning ${fmt(ctx.paths.length)} tracked files…\n`);
  const data = await reportData(o, ctx);
  if (o.mode === "json") {
    process.stdout.write(`${JSON.stringify(jsonReport(data), null, 2)}\n`);
    return 0;
  }
  if (o.mode === "html") return writeHtml(o, ctx, data);
  process.stdout.write(
    terminalReport({
      ...data,
      date: data.generatedAt.slice(0, 10),
      unreadable: data.testRunners.unreadable,
      topModules: o.top,
      htmlCommand: `bun ${shellQuote(import.meta.path)} --html`,
      colour: useColour(process.stdout.isTTY === true),
    }),
  );
  return 0;
}

if (import.meta.main)
  runMain("code-stats", async () => {
    let options: Options;
    try {
      options = parseArgs(process.argv.slice(2));
    } catch (error) {
      if (error instanceof UsageError)
        fail(2, `code-stats: ${error.message}`, "", USAGE);
      throw error;
    }
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    try {
      return await run(options);
    } catch (error) {
      if (error instanceof CodeStatsError)
        fail(1, `code-stats: ${error.message}`);
      throw error;
    }
  });
