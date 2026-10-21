// Ratchet: counted findings may fall but never rise above the merge base's.
//
// A rule set to "warn" is ratcheted: its findings are tolerated, but a change
// may not add to them. The counts are derived from the merge base at run time,
// never stored, so parallel pull requests that each remove findings do not
// conflict over a baseline file. Both trees are measured with the head's tools
// and configuration, so a tool upgrade or a newly ratcheted rule moves both
// counts alike.
//
// Because of that, a configuration change that loosens a rule would pass the
// count comparison. Two checks catch it, and either passes only when a commit
// in the range carries a `Ratchet-Loosen: <name>: <reason>` trailer:
// - measured: the base tree is counted under its own configuration and under
//   the head's; a rule that finds less under the head's was loosened, however
//   the configuration did it (a severity, an override, an excluded path, an
//   edited lint plugin, a compiler flag);
// - declared: a rule, override, file scope or compiler flag the configuration
//   files set less strictly than the base did, or an order-sensitive list
//   reordered, which also covers rules with no findings to measure. Any other setting of a configuration file the base's
//   wiring already compared is not ranked, so changing it counts as well.
//
// Usage: ratchet.ts --config <file> [--base <ref>] [--report]
//   --config  JSON wiring: which commands produce findings and which
//             configuration files to compare (see README.md)
//   --base    branch to compare against (default: RATCHET_BASE, else
//             origin/main); the merge base with HEAD is measured
//   --report  print the current counts only; no comparison, always exits 0
// Exit: 0 pass (or skipped locally without a base, and said so), 1 a count
// grew or a rule was loosened, 2 could not check: a usage or configuration
// error, or no merge base in CI.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { couldNotCheck } from "../../../../lib/findings.ts";
import { LEAKY_GIT_ENV } from "../../../../plugin/shared/guarded-git-spawn.ts";

export { parseCountsJson } from "./ratchet-json.ts";
export {
  parseJsonc,
  strictness,
  ordering,
  reordered,
  unranked,
  loosened,
} from "./ratchet-config.ts";
export type {
  Counter,
  ConfigFile,
  RatchetConfig,
  Counts,
  Measured,
} from "./ratchet-types.ts";

function add(counts: Counts, rule: string, file: string, n = 1): void {
  const files = counts.get(rule) ?? new Map<string, number>();
  files.set(file, (files.get(file) ?? 0) + n);
  counts.set(rule, files);
}

export function total(files: Map<string, number> | undefined): number {
  let sum = 0;
  for (const n of files?.values() ?? []) sum += n;
  return sum;
}

interface BiomeDiagnostic {
  severity?: string;
  category?: string;
  message?: string;
  location?: { path?: string | { file?: string } };
}

function biomeRule(d: BiomeDiagnostic): string {
  const rule = (d.category ?? "unknown").replace(/^lint\//, "");
  if (rule !== "plugin") return rule;
  return /^([\w-]+\/[\w-]+):/.exec(d.message ?? "")?.[1] ?? "plugin";
}

/**
 * Biome's JSON reporter: warnings are ratcheted, errors enforced. Plugin
 * diagnostics carry no rule name, so a plugin states its own as a
 * `<scope>/<name>:` prefix of its message.
 */
export function parseBiome(stdout: string): Measured {
  const report: unknown = JSON.parse(stdout);
  const diagnostics = record(report).diagnostics;
  if (!Array.isArray(diagnostics))
    throw new Error("biome report has no diagnostics list");
  const out: Measured = { ratcheted: new Map(), all: new Map() };
  for (const d of diagnostics as BiomeDiagnostic[]) {
    if (d.severity !== "warning" && d.severity !== "error") continue;
    const path = d.location?.path;
    const file = (typeof path === "string" ? path : path?.file) ?? "?";
    const rule = biomeRule(d);
    add(out.all, rule, file);
    if (d.severity === "warning") add(out.ratcheted, rule, file);
  }
  return out;
}

/** Compiler output in `tsc --pretty false` form, counted per error code. */
export function parseTsc(stdout: string): Counts {
  const counts: Counts = new Map();
  for (const line of stdout.split("\n")) {
    const m = /^(.+?)\(\d+,\d+\): error (TS\d+):/.exec(line.trim());
    if (m?.[1] && m[2]) add(counts, m[2], m[1]);
  }
  return counts;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !(LEAKY_GIT_ENV as readonly string[]).includes(k.toUpperCase())
    )
      env[k] = v;
  return env;
}

/**
 * Run a command in `cwd`. Like a package script, a bare command name is found
 * in the tree's `node_modules/.bin` before `PATH`.
 */
function run(
  cmd: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const [name = "", ...args] = cmd;
  const path = `${join(cwd, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;
  const bin = Bun.which(name, { PATH: path }) ?? name;
  const r = Bun.spawnSync([bin, ...args], {
    cwd,
    env: { ...cleanEnv(), ...extraEnv },
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

function git(args: string[], cwd: string): string | undefined {
  const r = run(["git", ...args], cwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** NUL-delimited and untrimmed: a file name may begin or end with a space. */
function listedFiles(tree: string, options: string[]): string[] {
  const r = run(["git", "ls-files", ...options, "-z"], tree);
  if (r.code !== 0) throw new Error(`cannot list files in ${tree}`);
  return [...new Set(r.stdout.split("\0").filter(Boolean))];
}

function grepCounts(
  tree: string,
  patterns: Record<string, string>,
  files?: string,
): Counts {
  const counts: Counts = new Map();
  const listed = listedFiles(tree, ["-co", "--exclude-standard"]);
  const res = Object.entries(patterns).map(
    ([rule, re]) => [rule, new RegExp(re, "g")] as const,
  );
  const only = new RegExp(files ?? "");
  const candidates = listed.filter(
    (f) =>
      f &&
      only.test(f) &&
      !f.includes("/fixtures/") &&
      !f.startsWith("node_modules/"),
  );
  for (const file of candidates) {
    const text = readable(tree, file) ?? "";
    for (const [rule, re] of res) {
      const n = text.match(re)?.length ?? 0;
      if (n) add(counts, rule, file, n);
    }
  }
  return counts;
}

function measureOne(tree: string, c: Counter, historical: boolean): Measured {
  if (c.format === "file-lines") {
    const counts = fileLineCounts(
      tree,
      listedFiles(tree, ["-co", "--exclude-standard"]),
      c,
      historical,
    );
    return { ratcheted: counts, all: counts };
  }
  if (c.format === "grep") {
    const counts = grepCounts(tree, c.patterns, c.files);
    return { ratcheted: counts, all: counts };
  }
  // A json command is told it measures a merge base, which may predate the
  // files it reads; the other formats read no such inputs.
  const r = run(
    c.command,
    tree,
    c.format === "json" && historical ? { RATCHET_HISTORICAL: "1" } : {},
  );
  if (c.format === "json") {
    if (r.code !== 0)
      throw new CountsError(
        `${c.name}: ${c.command.join(" ")} exited ${r.code}:\n${r.stdout}${r.stderr}`,
      );
    const counts = parseCountsJson(r.stdout);
    return { ratcheted: counts, all: counts };
  }
  if (c.format === "biome-json") {
    if (!r.stdout.trim())
      throw new Error(`${c.name}: no output from ${c.command.join(" ")}`);
    return parseBiome(r.stdout);
  }
  const counts = parseTsc(r.stdout);
  // A configuration error (an unknown project, a bad option) also exits
  // non-zero, but names no file; read as zero findings it would pass forever.
  if (r.code !== 0 && counts.size === 0)
    throw new Error(
      `${c.name}: ${c.command.join(" ")} failed without findings:\n${r.stdout}${r.stderr}`,
    );
  return { ratcheted: counts, all: counts };
}

/**
 * Measure one tree: counter name → its findings. A `historical` tree (the
 * merge base) may predate every file a counter's scope matches.
 */
export function measure(
  tree: string,
  counters: Counter[],
  historical = false,
): Map<string, Measured> {
  return new Map(
    counters.map((c) => [c.name, measureOne(tree, c, historical)]),
  );
}

import { fileLineCounts } from "./ratchet-file-lines.ts";
import { CountsError, lostCounts, parseCountsJson } from "./ratchet-json.ts";
import { readable, record } from "./ratchet-common.ts";
import {
  loosened,
  ordering,
  parseJsonc,
  reordered,
  strictness,
  unranked,
} from "./ratchet-config.ts";
import type {
  ConfigFile,
  Counter,
  Counts,
  Measured,
  RatchetConfig,
} from "./ratchet-types.ts";

/**
 * The names `Ratchet-Loosen: <name>: <reason>` trailers accept. The input is
 * trailer values as git parses them (the last paragraph of a message), one
 * per line; a value with no reason on the same line accepts nothing.
 */
export function trailers(values: string): Set<string> {
  const out = new Set<string>();
  for (const line of values.split("\n")) {
    const m = /^([^\s:]+)[ \t]*:[ \t]*\S/.exec(line.trim());
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

/**
 * The name a trailer gives for a setting: a rule without its group or
 * override scope (`suspicious/noDebugger` → `noDebugger`), a plugin by its
 * file name, any file scope as `includes`.
 */
function shortName(rule: string): string {
  if (rule.startsWith("includes[")) return "includes";
  return (
    rule
      .replace(/@.*$/, "")
      .replace(/^plugin:/, "")
      .replace(/\.grit$/, "")
      .split("/")
      .pop() ?? rule
  );
}

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const optionalString = (v: unknown) => v === undefined || typeof v === "string";
const hasCommand = (c: Record<string, unknown>) =>
  strings(c.command) && c.command.length > 0;

/** Each format's own fields, checked once its name is known. */
const COUNTER_SHAPES: Record<string, (c: Record<string, unknown>) => boolean> =
  {
    "file-lines": (c) =>
      typeof c.limit === "number" &&
      Number.isSafeInteger(c.limit) &&
      c.limit > 0 &&
      typeof c.files === "string" &&
      optionalString(c.exclude),
    json: (c) => hasCommand(c) && (c.per === undefined || c.per === "file"),
    grep: (c) =>
      typeof c.patterns === "object" &&
      c.patterns !== null &&
      !Array.isArray(c.patterns) &&
      Object.values(c.patterns).every((x) => typeof x === "string") &&
      optionalString(c.files),
    "biome-json": hasCommand,
    tsc: hasCommand,
  };

function validCounter(v: unknown): v is Counter {
  const c = record(v);
  if (typeof c.name !== "string" || !c.name) return false;
  const shape =
    typeof c.format === "string" && Object.hasOwn(COUNTER_SHAPES, c.format)
      ? COUNTER_SHAPES[c.format]
      : undefined;
  return shape?.(c) ?? false;
}

function validConfigFile(v: unknown): v is ConfigFile {
  const c = record(v);
  return (
    typeof c.path === "string" &&
    (c.kind === "biome" || c.kind === "tsconfig" || c.kind === "fallow")
  );
}

/**
 * Check a wiring's shape. Counters are keyed by name, so a second counter
 * with a name already taken would silently replace the first's measurement.
 */
function validated(doc: Record<string, unknown>, where: string): RatchetConfig {
  const { counters, configs, support } = doc;
  if (!Array.isArray(counters) || !Array.isArray(configs))
    throw new Error(`${where}: needs "counters" and "configs" lists`);
  if (!counters.every(validCounter) || !configs.every(validConfigFile))
    throw new Error(`${where}: a counter or config entry is malformed`);
  const names = counters.map((c: Counter) => c.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length)
    throw new Error(
      `${where}: counter names must be unique: ${twice.join(", ")}`,
    );
  if (support !== undefined && !strings(support))
    throw new Error(`${where}: "support" must list paths`);
  const paths = [...configs.map((c: ConfigFile) => c.path), ...(support ?? [])];
  const outside = paths.filter((p) => !inRepository(p));
  if (outside.length)
    throw new Error(
      `${where}: a path must name a place inside the repository, in its plain form: ${outside.join(", ")}`,
    );
  return doc as unknown as RatchetConfig;
}

/**
 * A path the wiring copies and compares by its spelling: relative, with
 * forward slashes, and no `.` or `..` segment. Copying joins it to a tree,
 * which would resolve `a/../b` to `b` while the comparison of support paths
 * still read it as inside `a`.
 */
function inRepository(path: string): boolean {
  const segments = path.replace(/\/+$/, "").split("/");
  return (
    !path.includes("\\") &&
    !/^[A-Za-z]:/.test(path) &&
    segments.every((s) => s !== "" && s !== "." && s !== "..")
  );
}

function loadConfig(path: string): RatchetConfig {
  return validated(record(parseJsonc(readFileSync(path, "utf8"))), path);
}

function printReport(counts: Map<string, Measured>): void {
  for (const [name, measured] of counts) {
    const rows = [...measured.ratcheted].sort(([a], [b]) => a.localeCompare(b));
    console.log(`${name}:${rows.length ? "" : " (none)"}`);
    for (const [rule, files] of rows)
      console.log(`  ${String(total(files)).padStart(5)}  ${rule}`);
  }
}

function growth(
  name: string,
  rule: string,
  before: Map<string, number> | undefined,
  after: Map<string, number>,
  perFile = false,
): string | undefined {
  const grew = perFile
    ? [...after].some(([f, n]) => n > (before?.get(f) ?? 0))
    : total(after) > total(before);
  if (!grew) return undefined;
  const worse = [...after]
    .filter(([f, n]) => n > (before?.get(f) ?? 0))
    .map(([f, n]) => `${f} (${before?.get(f) ?? 0} → ${n})`);
  return `${name} ${rule}: ${total(before)} → ${total(after)}\n      ${worse.join("\n      ")}`;
}

function promotions(
  name: string,
  base: Counts,
  head: Counts,
  whole: boolean,
): string[] {
  if (whole) {
    const before = [...base.values()].reduce((n, f) => n + total(f), 0);
    return before > 0 && head.size === 0 ? [name] : [];
  }
  return [...base]
    .filter(([rule, files]) => total(files) > 0 && total(head.get(rule)) === 0)
    .map(([rule]) => `${name} ${rule}`);
}

/**
 * Compare two trees' counts. A rule this change brings to zero is reported
 * for promotion to an enforced error. For compiler output, whose rules are
 * error codes rather than settings, the whole counter is the unit: it is
 * reported once every code is at zero. A `perFile` counter's rule grows when
 * any one file's count does, whatever its total. A `noPromotion` counter has
 * no rule to promote: its findings stay ratcheted at zero.
 */
export function compare(
  base: Map<string, Counts>,
  head: Map<string, Counts>,
  wholeCounter: ReadonlySet<string> = new Set(),
  perFile: ReadonlySet<string> = new Set(),
  noPromotion: ReadonlySet<string> = new Set(),
): { grew: string[]; promote: string[] } {
  const grew: string[] = [];
  const promote: string[] = [];
  for (const [name, headRules] of head) {
    const baseRules: Counts = base.get(name) ?? new Map();
    for (const [rule, files] of headRules) {
      const line = growth(
        name,
        rule,
        baseRules.get(rule),
        files,
        perFile.has(name),
      );
      if (line) grew.push(line);
    }
    if (!noPromotion.has(name))
      promote.push(
        ...promotions(name, baseRules, headRules, wholeCounter.has(name)),
      );
  }
  return { grew, promote };
}

function byShortName(counts: Counts): Map<string, number> {
  const out = new Map<string, number>();
  for (const [rule, files] of counts)
    out.set(shortName(rule), (out.get(shortName(rule)) ?? 0) + total(files));
  return out;
}

/**
 * Rules that find less in the same tree under the head's configuration than
 * under its own. Compared by rule name alone, so a rule that moves between
 * groups is not a loss.
 */
export function measuredLoosening(
  own: Counts,
  underHead: Counts,
): { rule: string; before: number; after: number }[] {
  const now = byShortName(underHead);
  return [...byShortName(own)]
    .filter(([rule, before]) => (now.get(rule) ?? 0) < before)
    .map(([rule, before]) => ({ rule, before, after: now.get(rule) ?? 0 }));
}

interface Options {
  configPath: string;
  baseRef: string;
  report: boolean;
}

function options(args: string[]): Options {
  const out: Options = {
    configPath: "",
    baseRef: process.env.RATCHET_BASE || "origin/main",
    report: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config") out.configPath = args[++i] ?? "";
    else if (a === "--base") out.baseRef = args[++i] ?? "";
    else if (a === "--report") out.report = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.configPath)
    throw new Error("usage: ratchet.ts --config <file> [--base <ref>]");
  return out;
}

interface BaseMeasurement {
  /** The base measured with the head's configuration and tools. */
  counts: Map<string, Measured>;
  /** The base measured with its own configuration, or why that failed. */
  own: Map<string, Measured | Error>;
  /** Each configuration file's strictness in the base. */
  strictness: Map<string, Map<string, number> | undefined>;
  /** Each configuration file's settings `strictness` does not rank. */
  unranked: Map<string, string | undefined>;
  /** Each configuration file's order-sensitive lists. */
  ordering: Map<string, Map<string, string[]> | undefined>;
}

function measureOwn(
  tree: string,
  counters: Counter[],
): Map<string, Measured | Error> {
  const out = new Map<string, Measured | Error>();
  for (const c of counters) {
    try {
      out.set(c.name, measureOne(tree, c, true));
    } catch (error) {
      out.set(
        c.name,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  return out;
}

/** Give `tree` the head's configuration and support files. */
function copyHeadConfiguration(
  root: string,
  tree: string,
  config: RatchetConfig,
) {
  const paths = [
    ...config.configs.map((c) => c.path),
    ...(config.support ?? []),
  ];
  for (const p of paths) {
    rmSync(join(tree, p), { recursive: true, force: true });
    if (!existsSync(join(root, p))) continue;
    mkdirSync(dirname(join(tree, p)), { recursive: true });
    cpSync(join(root, p), join(tree, p), { recursive: true });
  }
}

/**
 * Check out `commit` beside the repository and measure it twice: with its own
 * configuration, then with the head's configuration, support files and
 * dependencies. Repository hooks and large-file filters do not run.
 */
function measureBase(
  root: string,
  commit: string,
  config: RatchetConfig,
): BaseMeasurement {
  const scratch = mkdtempSync(join(tmpdir(), "ratchet-"));
  const tree = join(scratch, "base");
  const hooks = join(scratch, "no-hooks");
  mkdirSync(hooks);
  git(["worktree", "prune"], root);
  const added = run(
    [
      "git",
      "-c",
      `core.hooksPath=${hooks}`,
      "worktree",
      "add",
      "--detach",
      tree,
      commit,
    ],
    root,
    { GIT_LFS_SKIP_SMUDGE: "1" },
  );
  try {
    if (added.code !== 0)
      throw new Error(`cannot check out ${commit}: ${added.stderr}`);
    if (existsSync(join(root, "node_modules")))
      // A junction on Windows needs no extra privilege; elsewhere the type
      // is ignored and a plain directory symlink is made.
      symlinkSync(
        join(root, "node_modules"),
        join(tree, "node_modules"),
        "junction",
      );
    const strictnessMap = new Map(
      config.configs.map((c) => [c.path, strictness(c.kind, tree, c.path)]),
    );
    const unrankedMap = new Map(
      config.configs.map((c) => [c.path, unranked(c.kind, tree, c.path)]),
    );
    const orderingMap = new Map(
      config.configs.map((c) => [c.path, ordering(c.kind, tree, c.path)]),
    );
    const own = measureOwn(tree, config.counters);
    copyHeadConfiguration(root, tree, config);
    return {
      counts: measure(tree, config.counters, true),
      own,
      strictness: strictnessMap,
      unranked: unrankedMap,
      ordering: orderingMap,
    };
  } finally {
    git(["worktree", "remove", "--force", tree], root);
    git(["worktree", "prune"], root);
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface Loosening {
  /** The name a `Ratchet-Loosen` trailer must give to accept it. */
  name: string;
  line: string;
  /**
   * A change to a compiler configuration (`setting`), or the compiler
   * findings measured as lost (`findings`). The findings are accepted only
   * when every compiler setting change is, each by its own trailer: then
   * nothing but approved changes can have caused the loss.
   */
  compiler?: "setting" | "findings";
}

/**
 * Settings set less strictly than in the base, and, for a configuration file
 * the base's wiring already compared, any change to a setting that is not
 * ranked. A file wired for the first time has no settled baseline yet; its
 * ranked settings are still compared.
 */
function declaredLoosenings(
  root: string,
  config: RatchetConfig,
  base: BaseMeasurement,
  baseWiring: RatchetConfig | undefined,
): Loosening[] {
  const out: Loosening[] = [];
  for (const c of config.configs) {
    const before = base.strictness.get(c.path);
    if (!before) continue;
    const compiler = c.kind === "tsconfig" && { compiler: "setting" as const };
    const now = strictness(c.kind, root, c.path) ?? new Map<string, number>();
    for (const setting of loosened(before, now))
      out.push({
        name: shortName(setting),
        line: `${c.path}: ${setting}`,
        ...compiler,
      });
    out.push(...orderLoosenings(root, c, base));
    const established = baseWiring?.configs.some(
      (b) => b.path === c.path && b.kind === c.kind,
    );
    if (
      established &&
      unranked(c.kind, root, c.path) !== base.unranked.get(c.path)
    )
      out.push({
        name: c.path,
        line: `${c.path}: a setting the ratchet does not rank changed`,
        ...compiler,
      });
  }
  return out;
}

function orderLoosenings(
  root: string,
  c: ConfigFile,
  base: BaseMeasurement,
): Loosening[] {
  const before = base.ordering.get(c.path);
  const now = ordering(c.kind, root, c.path);
  if (!before || !now) return [];
  return reordered(before, now).map((list) => ({
    name: c.path,
    line: `${c.path}: the order of ${list} changed`,
  }));
}

/**
 * The base's own configuration may not run with the head's tools. For a
 * counter the base's wiring does not have yet (a file it names does not exist
 * there), the measured check is skipped and the declared check still applies.
 * For one the base already measured, the failure is itself a loosening: the
 * check that catches overrides, excluded paths and edited plugins cannot run.
 */
function unmeasured(
  c: Counter,
  error: Error,
  baseWiring: RatchetConfig | undefined,
): Loosening | undefined {
  const reason = error.message.split("\n")[0];
  if (!baseWiring?.counters.some((b) => b.name === c.name)) {
    console.log(
      `ratchet: ${c.name}: the base's own configuration did not run; measured loosening check skipped (${reason})`,
    );
    return undefined;
  }
  return {
    name: c.name,
    line: `${c.name}: the base's own configuration did not run, so the measured loosening check cannot (${reason})`,
  };
}

function counterLoosenings(
  c: Counter,
  own: Measured,
  underHead: Measured,
): Loosening[] {
  // A counting command's rules are its own names, not settings: its trailer
  // names the counter.
  if (c.format === "json")
    return lostCounts(own.all, underHead.all, c.per === "file").map(
      ({ what, before, after }) => ({
        name: c.name,
        line: `${c.name} ${what}: ${before} → ${after} in the base under this change's configuration`,
      }),
    );
  return measuredLoosening(own.all, underHead.all).map(
    ({ rule, before, after }) => ({
      // A compiler counter's findings are error codes, not settings, so its
      // trailer names the counter.
      name: c.format === "tsc" ? c.name : rule,
      line: `${c.name} ${rule}: ${before} → ${after} in the base under this change's configuration`,
      ...(c.format === "tsc" && { compiler: "findings" as const }),
    }),
  );
}

function measuredLoosenings(
  config: RatchetConfig,
  base: BaseMeasurement,
  baseWiring: RatchetConfig | undefined,
): Loosening[] {
  return config.counters.flatMap((c) => {
    const own = base.own.get(c.name);
    const underHead = base.counts.get(c.name);
    if (!own || !underHead || c.format === "grep") return [];
    if (own instanceof Error) return unmeasured(c, own, baseWiring) ?? [];
    return counterLoosenings(c, own, underHead);
  });
}

/**
 * Whether a counter measures differently from the base's: another format or
 * command, another file filter, or a pattern removed or changed. The head's
 * definition measures both trees, so such a change moves both counts alike
 * and the comparison alone cannot see it.
 */
function counterChanged(before: Counter, now: Counter): boolean {
  if (before.format === "file-lines")
    return (
      now.format !== "file-lines" ||
      now.limit > before.limit ||
      before.files !== now.files ||
      (now.exclude !== undefined && before.exclude !== now.exclude)
    );
  if (before.format === "json")
    return (
      now.format !== "json" ||
      JSON.stringify(before.command) !== JSON.stringify(now.command) ||
      (before.per === "file" && now.per !== "file")
    );
  if (before.format === "grep")
    return (
      now.format !== "grep" ||
      before.files !== now.files ||
      Object.entries(before.patterns).some(([k, v]) => now.patterns[k] !== v)
    );
  return (
    now.format !== before.format ||
    JSON.stringify(before.command) !== JSON.stringify(now.command)
  );
}

/**
 * Counters, configuration files and support paths the base's own ratchet
 * wiring had and the head's lacks or changed. A support path no longer copied
 * leaves the base's own plugin in place, so an edit to it goes unmeasured. A
 * configuration file or support path added or widened replaces the base's
 * copy of it with the head's, so the findings there are no longer compared;
 * `inBase` says whether the base has a copy to replace.
 */
function wiringLoosenings(
  baseWiring: RatchetConfig | undefined,
  config: RatchetConfig,
  inBase: (path: string) => boolean,
): Loosening[] {
  if (!baseWiring) return [];
  const out: Loosening[] = [];
  for (const before of baseWiring.counters) {
    const now = config.counters.find((c) => c.name === before.name);
    if (!now || counterChanged(before, now))
      out.push({
        name: before.name,
        line: `ratchet wiring: counter ${before.name}`,
      });
  }
  for (const before of baseWiring.configs) {
    const kept = config.configs.some(
      (c) => c.path === before.path && c.kind === before.kind,
    );
    if (!kept)
      out.push({
        name: before.path,
        line: `ratchet wiring: config ${before.path} (${before.kind})`,
      });
  }
  return [...out, ...copiedLoosenings(baseWiring, config, inBase)];
}

function copiedLoosenings(
  baseWiring: RatchetConfig,
  config: RatchetConfig,
  inBase: (path: string) => boolean,
): Loosening[] {
  const trim = (p: string) => p.replace(/\/+$/, "");
  const support = (config.support ?? []).map(trim);
  const baseSupport = (baseWiring.support ?? []).map(trim);
  const covers = (outer: string, inner: string) =>
    inner === outer || inner.startsWith(`${outer}/`);
  const dropped = baseSupport
    .filter((before) => !support.some((p) => covers(p, before)))
    .map((before) => ({
      name: before,
      line: `ratchet wiring: support ${before}`,
    }));
  const baseCopied = [...baseWiring.configs.map((c) => c.path), ...baseSupport];
  const added = [
    ...config.configs.map((c) => ({ path: c.path, what: "config" })),
    ...support.map((path) => ({ path, what: "support" })),
  ]
    .filter(({ path }) => !baseCopied.some((b) => covers(b, path)))
    .filter(({ path }) => inBase(path))
    .map(({ path, what }) => ({
      name: path,
      line: `ratchet wiring: ${what} ${path} added, so the base's copy of it is replaced`,
    }));
  return [...dropped, ...added];
}

function report(lines: {
  promote: string[];
  waived: Loosening[];
  grew: string[];
  loose: Loosening[];
}): void {
  for (const line of lines.promote)
    console.log(`ratchet: promote to error: ${line} is at 0`);
  for (const l of lines.waived)
    console.log(`ratchet: LOOSENED with a Ratchet-Loosen trailer: ${l.line}`);
  for (const line of lines.grew) console.error(`ratchet: count grew: ${line}`);
  for (const l of lines.loose)
    console.error(
      `ratchet: rule loosened: ${l.line}\n  only if a person asked for it, add the commit trailer "Ratchet-Loosen: ${l.name}: <reason>"`,
    );
}

function missingBase(baseRef: string): number {
  const message = `cannot find the merge base with ${baseRef}`;
  if (process.env.CI)
    return couldNotCheck(
      "ratchet",
      `${message}; CI needs the base history (fetch-depth: 0)`,
    );
  console.error(`ratchet: ${message}; comparison skipped`);
  return 0;
}

function baseWiringOf(commit: string, configPath: string) {
  // Named relative to the working directory (`<commit>:./<path>`), never to
  // the top level git prints: on Windows the two can spell one directory
  // differently (a short 8.3 name against the long one). Git names a file in
  // a commit with forward slashes on every system.
  const cwd = process.cwd();
  const path = relative(cwd, configPath).split(sep).join("/");
  const text = git(["show", `${commit}:./${path}`], cwd);
  return text === undefined ? undefined : loadConfigText(text);
}

function loadConfigText(text: string): RatchetConfig | undefined {
  const doc = record(parseJsonc(text));
  return Array.isArray(doc.counters)
    ? validated(doc, "the base's ratchet wiring")
    : undefined;
}

function main(args: string[]): number {
  const opts = options(args);
  const top = git(["rev-parse", "--show-toplevel"], process.cwd());
  if (!top) throw new Error("not inside a git repository");
  // Git prints the top level with forward slashes, also on Windows; resolve
  // gives it the system's form, so paths derived from it compare equal.
  const root = resolve(top);
  const configPath = resolve(opts.configPath);
  const config = loadConfig(configPath);
  const head = measure(root, config.counters);
  if (opts.report) {
    printReport(head);
    return 0;
  }
  const mergeBase = git(["merge-base", "HEAD", opts.baseRef], root);
  if (!mergeBase) return missingBase(opts.baseRef);

  const base = measureBase(root, mergeBase, config);
  const ratcheted = (m: Map<string, Measured>) =>
    new Map([...m].map(([name, v]) => [name, v.ratcheted]));
  const tsc = config.counters
    .filter((c) => c.format === "tsc")
    .map((c) => c.name);
  const perFile = config.counters
    .filter((c) => c.format === "json" && c.per === "file")
    .map((c) => c.name);
  // File-size limits and counting commands have no linter rule to promote.
  const noPromotion = config.counters
    .filter((c) => c.format === "file-lines" || c.format === "json")
    .map((c) => c.name);
  const { grew, promote } = compare(
    ratcheted(base.counts),
    ratcheted(head),
    new Set(tsc),
    new Set(perFile),
    new Set(noPromotion),
  );

  const values =
    git(
      [
        "log",
        "--format=%(trailers:key=Ratchet-Loosen,valueonly,separator=%x0A)",
        `${mergeBase}..HEAD`,
      ],
      root,
    ) ?? "";
  const allowed = trailers(values);
  const baseWiring = baseWiringOf(mergeBase, configPath);
  const all = [
    ...declaredLoosenings(root, config, base, baseWiring),
    ...measuredLoosenings(config, base, baseWiring),
    ...wiringLoosenings(
      baseWiring,
      config,
      (path) =>
        git(["cat-file", "-e", `${mergeBase}:${path}`], root) !== undefined,
    ),
  ];
  // Lost compiler findings are accepted only when every compiler setting
  // change is, so the loss can come from approved changes alone.
  const settings = all.filter((l) => l.compiler === "setting");
  const settingsWaived =
    settings.length > 0 && settings.every((l) => allowed.has(l.name));
  const accepted = (l: Loosening) =>
    allowed.has(l.name) || (l.compiler === "findings" && settingsWaived);
  const waived = all.filter(accepted);
  const loose = all.filter((l) => !accepted(l));

  report({ promote, waived, grew, loose });
  if (grew.length || loose.length) return 1;
  console.log(
    `ratchet: no count grew and no rule loosened without a Ratchet-Loosen trailer against ${mergeBase.slice(0, 12)} (${config.counters.length} counters: ${config.counters.map((c) => c.name).join(", ")})`,
  );
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
