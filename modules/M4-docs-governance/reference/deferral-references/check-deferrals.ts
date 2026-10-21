#!/usr/bin/env bun
// Deferral references gate: a document that defers work to the tracker
// ("tracked to closure", "a follow-up will be filed") must name the item that
// carries it, and the item it names must still be open.
//
// Two halves, one reader of the documents:
//
//   static  Offline and deterministic. Every block of prose (a paragraph, a
//           list item, a table row, a heading) that holds a deferral marker
//           phrase must also hold an item reference. The rule is stated in
//           the positive, as "a deferral names an item", because a promise
//           can be worded without end while a reference has one configured
//           shape. Runs on the lines a change adds (`--staged` for a
//           pre-commit hook, `--range` or DIFF_RANGE for a pull request) or
//           on every document (`--all`).
//   live    Needs the tracker, so it never runs on code from a pull request.
//           `--all --list-keys` prints the items the documents rely on; a
//           separate step that holds the tracker credential writes their
//           states to a file; `--all --states <file>` fails a deferral whose
//           items are all closed or do not exist. This script never reads a
//           credential and never makes a network call.
//
// What a green run means. No deferral names no item and, in the live half, no
// deferral relies only on closed items. It does not mean the item named is
// the right one, or that the promise is kept. A block that names an unrelated
// item beside a deferral passes: the static half checks that something is
// named, review checks what.
//
// Exit codes: 0 no findings (or `--ci` with nothing to compare, said aloud);
// 1 at least one finding; 2 the check could not run (bad configuration or
// arguments, an unreadable range, a state file missing an item or naming a
// state this script does not know). An unverified result never passes.
//
// Usage:
//   check-deferrals.ts [--config <file>] --staged
//   check-deferrals.ts [--config <file>] [--ci] --range=origin/main...HEAD
//   check-deferrals.ts [--config <file>] --all
//   check-deferrals.ts [--config <file>] --all --list-keys
//   check-deferrals.ts [--config <file>] --all --states <states.json>
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { cli, splitLines } from "../docs";
import { type Unit, units } from "./blocks";

/** Phrases that promise tracked work, when the configuration names none. */
export const DEFAULT_MARKERS = [
  "tracked to closure",
  "tracked separately",
  "will be tracked",
  "to be tracked",
  "will be filed",
  "to be filed",
  "follow-up will",
  "follow-up to be",
  "deferred to a future",
];

/** A check that could not run: bad configuration, arguments or input. */
class DeferralsError extends Error {}

export const DEFAULT_CONFIG = ".config/deferral-references.yaml";

export interface Config {
  /** Globs of the documents in scope, from the repository root. */
  include: string[];
  exclude: string[];
  /** What names an item. Group 1 is the key; without a group, the match. */
  items: RegExp[];
  markers: RegExp[];
}

const KNOWN_KEYS = ["version", "include", "exclude", "items", "markers"];

function textList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || v.trim() === "")
  )
    throw new DeferralsError(`${field} must be a list of non-empty strings`);
  return value as string[];
}

/** Whitespace runs collapse and emphasis marks go, so wrapped or bold text matches. */
const flatten = (text: string) =>
  text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A phrase as a case-insensitive pattern that must start and end on a word edge. */
function markerPattern(phrase: string): RegExp {
  const body = flatten(phrase).split(" ").map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

export function parseConfig(text: string, source: string): Config {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (error) {
    throw new DeferralsError(
      `${source}: not readable YAML: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new DeferralsError(`${source}: must be a mapping`);
  const fields = raw as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length > 0)
    throw new DeferralsError(
      `${source}: unknown key ${unknown.join(", ")} (known: ${KNOWN_KEYS.join(", ")})`,
    );
  if (fields.version !== undefined && fields.version !== 1)
    throw new DeferralsError(`${source}: version must be 1`);
  const list = (field: string, fallback: string[]) =>
    fields[field] === undefined
      ? fallback
      : textList(fields[field], `${source}: ${field}`);
  // An empty `include` judges no document and empty `markers` find no
  // deferral: either turns the gate off while it still passes.
  const required = (field: string, fallback: string[]) => {
    const value = list(field, fallback);
    if (value.length === 0)
      throw new DeferralsError(
        `${source}: ${field} must list at least one entry; an empty list turns the check off`,
      );
    return value;
  };
  const itemPatterns = list("items", []);
  if (itemPatterns.length === 0)
    throw new DeferralsError(
      `${source}: items must list at least one pattern that names an item; no default fits every tracker, and a loose one reads other identifiers (ADR-12, CVE-2024-1) as items`,
    );
  const items = itemPatterns.map((pattern) => {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "g");
    } catch (error) {
      throw new DeferralsError(
        `${source}: items pattern ${JSON.stringify(pattern)} does not compile: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (regex.test(""))
      throw new DeferralsError(
        `${source}: items pattern ${JSON.stringify(pattern)} matches the empty string`,
      );
    regex.lastIndex = 0;
    return regex;
  });
  return {
    include: required("include", ["**/*.md"]),
    exclude: list("exclude", []),
    items,
    markers: required("markers", DEFAULT_MARKERS).map(markerPattern),
  };
}

export function inScope(config: Config, path: string): boolean {
  const matches = (glob: string) => new Bun.Glob(glob).match(path);
  return config.include.some(matches) && !config.exclude.some(matches);
}

export interface Deferral {
  unit: Unit;
  marker: string;
  /** Distinct item keys the block names, sorted. */
  keys: string[];
}

export interface Finding {
  /** The block's first line, and its last. */
  line: number;
  end: number;
  rule: string;
  problem: string;
  remedy: string;
  excerpt: string;
}

export interface Reading {
  deferrals: Deferral[];
  /** Findings of the static half: waivers without a reason, deferrals naming no item. */
  findings: Finding[];
}

const excerptOf = (unit: Unit) => {
  const first = flatten(unit.text.split("\n")[0] ?? "");
  return first.length > 100 ? `${first.slice(0, 97)}...` : first;
};

const finding = (
  unit: Unit,
  rule: string,
  problem: string,
  remedy: string,
): Finding => ({
  line: unit.start,
  end: unit.end,
  rule,
  problem,
  remedy,
  excerpt: excerptOf(unit),
});

/** Item keys in code-unit order, the same on every machine and locale. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The deferral a block makes, or undefined when it holds no marker phrase. */
function deferralOf(unit: Unit, config: Config): Deferral | undefined {
  const bare = unit.text.replace(/\s+/g, " ");
  const text = flatten(bare);
  const marker = config.markers.map((m) => m.exec(text)?.[0]).find(Boolean);
  if (marker === undefined) return undefined;
  // Items are read as written, so a pattern may hold `_` or `*`, and also
  // without emphasis marks, which finds `_ENG-5_` beside a plain `ENG-6`.
  const keysIn = (from: string) =>
    config.items.flatMap((pattern) =>
      [...from.matchAll(pattern)]
        // A pattern with a group names the key by it, and a group that took
        // no part in the match names nothing; without a group, the match.
        .map((m) => (m.length > 1 ? (m[1] ?? "") : m[0]))
        // A pattern can match nothing in real text (a lookahead, an empty
        // group); an empty key names no item.
        .filter((key) => key !== ""),
    );
  return {
    unit,
    marker,
    keys: [...new Set([...keysIn(bare), ...keysIn(text)])].sort(byCodeUnit),
  };
}

/**
 * Every deferral in a document and the static half's findings. A block with a
 * `<!-- deferral-ok: reason -->` comment is set aside, in both halves; a
 * waiver without a reason is itself a finding. Comments are blanked before
 * the block is read, so an item or phrase hidden in one counts for nothing.
 */
export function readDocument(content: string, config: Config): Reading {
  const reading: Reading = { deferrals: [], findings: [] };
  for (const unit of units(content)) {
    if (unit.waivers.length > 0) {
      if (unit.waivers.some((reason) => !/[^\s:]/.test(reason)))
        reading.findings.push(
          finding(
            unit,
            "deferral-waiver-without-reason",
            "a deferral-ok comment gives no reason",
            "write the reason: <!-- deferral-ok: why this names no item -->",
          ),
        );
      continue;
    }
    const deferral = deferralOf(unit, config);
    if (deferral === undefined) continue;
    reading.deferrals.push(deferral);
    if (deferral.keys.length === 0)
      reading.findings.push(
        finding(
          unit,
          "deferral-names-no-item",
          `"${deferral.marker}" promises tracked work but the block names no item`,
          "file the item now and name it in the same block, or say what is true today instead of promising",
        ),
      );
  }
  return reading;
}

export type ItemState = "open" | "closed" | "not_found";

const STATES: readonly string[] = ["open", "closed", "not_found"];

/** The provider's answer: a JSON object from item key to `open`, `closed` or `not_found`. */
export function parseStates(
  text: string,
  source: string,
): Map<string, ItemState> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DeferralsError(`${source}: not JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new DeferralsError(
      `${source}: must be a JSON object from item key to state`,
    );
  const states = new Map<string, ItemState>();
  for (const [key, state] of Object.entries(raw)) {
    if (typeof state !== "string" || !STATES.includes(state))
      throw new DeferralsError(
        `${source}: ${key} has state ${JSON.stringify(state)}, not one of ${STATES.join(", ")}`,
      );
    states.set(key, state as ItemState);
  }
  return states;
}

/**
 * The live half. A deferral fails when none of the items it names is open: a
 * block citing a closed item as provenance beside an open one is correct. An
 * item with no recorded state was never verified, which is an error and not a
 * pass.
 */
export function liveFindings(
  deferrals: Deferral[],
  states: Map<string, ItemState>,
): Finding[] {
  const missing = new Set<string>();
  for (const d of deferrals)
    for (const key of d.keys) if (!states.has(key)) missing.add(key);
  if (missing.size > 0)
    throw new DeferralsError(
      `no state for ${[...missing].join(", ")}: the provider did not answer for every item, so nothing was verified`,
    );
  const findings: Finding[] = [];
  for (const d of deferrals) {
    const answers = d.keys.map((key) => [key, states.get(key)] as const);
    if (answers.length === 0 || answers.some(([, s]) => s === "open")) continue;
    const named = answers
      .map(
        ([key, s]) =>
          `${key} (${s === "closed" ? "closed" : "does not exist"})`,
      )
      .join(", ");
    findings.push(
      finding(
        d.unit,
        "deferral-relies-on-closed-item",
        `"${d.marker}" relies on ${named}; none is still open`,
        "if the work was done, say so and drop the promise; if it was dropped, say that; otherwise name an open item",
      ),
    );
  }
  return findings;
}

// ── Which documents and lines ──────────────────────────────────────────────

type Env = Record<string, string | undefined>;

/**
 * The repository a run judges, and where and how every git call in it runs:
 * in the caller's directory with the caller's environment, so the repository
 * and index git reads (`GIT_DIR`, `GIT_INDEX_FILE`, ...) are the ones the
 * caller named, a relative value included. Paths git prints or is given are
 * the repository root's: `--full-name`, `--no-relative`, `:(top)` pathspecs.
 * The one part of that environment left out is what changes how git reads a
 * pathspec (`PATHSPEC_CONTROLS`): the gate's own pathspecs carry their
 * meaning in their magic, which a caller's literal or case-folding setting
 * would turn into different paths.
 */
interface Repo {
  root: string;
  cwd: string;
  env: Env;
}

/** Settings that change how git reads every pathspec it is given. */
const PATHSPEC_CONTROLS = [
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
];

/** The caller's environment, less the settings that reinterpret pathspecs. */
function gitEnv(env: Env): Env {
  const out = { ...env };
  for (const key of PATHSPEC_CONTROLS) delete out[key];
  return out;
}

function gitRaw(repo: Repo, args: string[], stdin?: Buffer): Buffer {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo.cwd,
    env: repo.env,
    ...(stdin === undefined ? {} : { stdin }),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new DeferralsError(
      `git ${args.join(" ")}: ${result.stderr.toString().trim()}`,
    );
  return result.stdout;
}

const git = (repo: Repo, args: string[]) => gitRaw(repo, args).toString();

/** The commit the new side is compared with. Both sides of a range are required. */
export function oldSide(repo: Repo, range: string): string {
  const resolveCommit = (ref: string) =>
    git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  const triple = range.split("...");
  const double = triple.length === 1 ? range.split("..") : [];
  const sides =
    triple.length > 1 ? triple : double.length > 1 ? double : [range];
  if (sides.length > 2 || sides.some((s) => s === ""))
    throw new DeferralsError(
      `range ${JSON.stringify(range)} is not A, A..B or A...B with both sides named (an unset base variable gives ...HEAD)`,
    );
  const [left, right] = sides as [string, string | undefined];
  const oldCommit = resolveCommit(left);
  // The new side is the working tree, but a named right side must still exist.
  const newCommit = right === undefined ? undefined : resolveCommit(right);
  if (triple.length > 1 && newCommit !== undefined)
    return git(repo, ["merge-base", oldCommit, newCommit]).trim();
  return oldCommit;
}

/**
 * The lines a unified-zero diff adds. A pure deletion marks the lines either
 * side of it and, given the new content, the nearest non-blank line either
 * side, so a block the deletion shortened is judged across blank lines too.
 */
export function addedLines(diff: string, content?: string): Set<number> {
  const lines = new Set<number>();
  const text = content === undefined ? undefined : splitLines(content);
  const blank = (n: number) =>
    text !== undefined && n >= 1 && n <= text.length && !text[n - 1]?.trim();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) {
      let before = start;
      while (blank(before)) lines.add(before--);
      lines.add(before);
      let after = start + 1;
      while (blank(after)) lines.add(after++);
      lines.add(after);
    }
    for (let n = start; n < start + count; n++) lines.add(n);
  }
  return lines;
}

interface Source {
  path: string;
  content: string;
  /** Lines the change adds; absent when every block is checked. */
  added?: Set<number>;
}

/** Which documents and lines are judged. */
export type Mode = "all" | "staged" | { range: string };

/** Every tracked document in scope, whole, from the working tree. */
function trackedSources(repo: Repo, config: Config): Source[] {
  const out: Source[] = [];
  for (const path of git(repo, [
    "ls-files",
    "-z",
    "--full-name",
    "--",
    ":/",
  ]).split("\0")) {
    const full = join(repo.root, path);
    if (!path || !inScope(config, path) || !existsSync(full)) continue;
    if (!lstatSync(full).isFile()) continue;
    out.push({ path, content: readFileSync(full, "utf8") });
  }
  return out;
}

/** Every document in scope as the index holds it, for a staged change. */
function indexedSources(repo: Repo, config: Config): Source[] {
  const blobs: Array<{ path: string; sha: string }> = [];
  for (const entry of git(repo, [
    "ls-files",
    "-s",
    "-z",
    "--full-name",
    "--",
    ":/",
  ]).split("\0")) {
    const match = /^(\d+) ([0-9a-f]+) \d+\t(.*)$/s.exec(entry);
    // Regular files only (100644, 100755): not links, not submodules.
    if (match === null || !match[1]?.startsWith("100")) continue;
    const [, , sha, path] = match as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (inScope(config, path)) blobs.push({ path, sha });
  }
  if (blobs.length === 0) return [];
  const output = gitRaw(
    repo,
    ["cat-file", "--batch"],
    Buffer.from(blobs.map((b) => `${b.sha}\n`).join("")),
  );
  const out: Source[] = [];
  let at = 0;
  for (const { path, sha } of blobs) {
    const eol = output.indexOf(10, at);
    const header = output.subarray(at, eol).toString();
    const size = Number(/^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1] ?? NaN);
    if (eol < 0 || !header.startsWith(sha) || !Number.isInteger(size))
      throw new DeferralsError(`git cat-file: cannot read ${path} (${header})`);
    out.push({
      path,
      content: output.subarray(eol + 1, eol + 1 + size).toString("utf8"),
    });
    at = eol + 1 + size + 1;
  }
  return out;
}

/** The documents in scope that a staged change or a range changes, with the lines it adds. */
function changedSources(
  repo: Repo,
  config: Config,
  mode: "staged" | { range: string },
  configRelative: string,
): Source[] {
  const staged = mode === "staged";
  const base = staged ? ["--cached"] : [oldSide(repo, mode.range)];
  const names = (...filter: string[]) =>
    git(repo, [
      "diff",
      "-z",
      "--name-only",
      "--no-relative",
      ...filter,
      ...base,
    ]).split("\0");
  // A new `items` pattern or marker changes what every document must satisfy,
  // so any change to the configuration (a removal or a change of type
  // included) judges them all.
  if (names().includes(configRelative))
    return staged ? indexedSources(repo, config) : trackedSources(repo, config);
  const paths = names("--diff-filter=ACMR");
  const out: Source[] = [];
  for (const path of paths) {
    if (!path || !inScope(config, path)) continue;
    const full = join(repo.root, path);
    if (!staged && !lstatSync(full).isFile()) continue;
    const diff = git(repo, [
      "diff",
      "-U0",
      "--no-color",
      // The raw text, whatever the repository's attributes say: a document
      // marked binary or given a text conversion still gets a line patch
      // whose numbers address the content being judged.
      "--text",
      "--no-textconv",
      "--no-ext-diff",
      "--no-relative",
      ...base,
      "--",
      `:(top,literal)${path}`,
    ]);
    const content = staged
      ? git(repo, ["show", `:${path}`])
      : readFileSync(full, "utf8");
    out.push({ path, content, added: addedLines(diff, content) });
  }
  return out;
}

/** For a staged change, the configuration's path in the index when the index has it. */
function indexedConfig(
  repo: Repo,
  configPath: string,
  mode: Mode | undefined,
): string | undefined {
  const path = relativePath(repo.root, configPath);
  return mode === "staged" &&
    git(repo, ["ls-files", "-z", "--", `:(top,literal)${path}`]) !== ""
    ? path
    : undefined;
}

/** The configuration a run judges by: for a staged change, the index's copy. */
function configText(repo: Repo, configPath: string, mode: Mode): string {
  const indexed = indexedConfig(repo, configPath, mode);
  return indexed === undefined
    ? readFileSync(configPath, "utf8")
    : git(repo, ["show", `:${indexed}`]);
}

const relativePath = (root: string, path: string) =>
  relative(root, path).split(sep).join("/");

function sources(
  repo: Repo,
  config: Config,
  mode: Mode,
  configPath: string,
): Source[] {
  return mode === "all"
    ? trackedSources(repo, config)
    : changedSources(repo, config, mode, relativePath(repo.root, configPath));
}

// ── Command line ───────────────────────────────────────────────────────────

const USAGE = `usage: check-deferrals.ts [--config <file>] (--staged | --range=<range> | --all)
       check-deferrals.ts [--config <file>] --all (--list-keys | --states <states.json>)`;

export function format(path: string, finding: Finding): string {
  return `${path}:${finding.line}: [${finding.rule}] ${finding.problem}\n  | ${finding.excerpt}\n  fix: ${finding.remedy}`;
}

/** What a command line asks for, checked as a whole. */
interface Plan {
  repo: Repo;
  configPath: string;
  /** Absent: `--ci` with no range, which compares nothing. */
  mode?: Mode;
  listKeys: boolean;
  /** As the command line named it, and resolved inside the repository. */
  states?: { name: string; path: string };
}

interface Flags {
  config?: string | undefined;
  all: boolean;
  staged: boolean;
  range?: string | undefined;
  ci: boolean;
  listKeys: boolean;
  states?: string | undefined;
}

function readFlags(argv: string[]): Flags {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        config: { type: "string" },
        all: { type: "boolean" },
        staged: { type: "boolean" },
        range: { type: "string" },
        ci: { type: "boolean" },
        "list-keys": { type: "boolean" },
        states: { type: "string" },
      },
    });
    return {
      ...values,
      all: values.all === true,
      staged: values.staged === true,
      ci: values.ci === true,
      listKeys: values["list-keys"] === true,
    };
  } catch (error) {
    throw new DeferralsError(
      `${error instanceof Error ? error.message : error}\n${USAGE}`,
    );
  }
}

/** The first way the flags contradict each other, as a usage error. */
function refuseContradiction(flags: Flags): void {
  const live = flags.listKeys || flags.states !== undefined;
  const refusals: Array<[boolean, string]> = [
    [
      flags.listKeys && flags.states !== undefined,
      "--list-keys and --states are separate steps",
    ],
    [
      live && !flags.all,
      "--list-keys and --states need --all: the tracker's answer is about every document, not a diff",
    ],
    [
      flags.all && (flags.staged || flags.range !== undefined),
      "--all cannot be combined with --staged or --range",
    ],
    [
      flags.staged && flags.range !== undefined,
      "--staged and --range choose different diffs; give one",
    ],
  ];
  const refusal = refusals.find(([contradicts]) => contradicts);
  if (refusal !== undefined)
    throw new DeferralsError(`${refusal[1]}\n${USAGE}`);
}

/** What to judge; undefined for `--ci` with no range, which compares nothing. */
function modeOf(flags: Flags, range: string | undefined): Mode | undefined {
  if (flags.all) return "all";
  if (flags.staged) return "staged";
  if (range !== undefined) return { range };
  return flags.ci ? undefined : "staged";
}

function plan(argv: string[], env: Env, cwd: string): Plan {
  const flags = readFlags(argv);
  refuseContradiction(flags);
  let repo: Repo;
  try {
    const forGit = gitEnv(env);
    const top = git({ root: cwd, cwd, env: forGit }, [
      "rev-parse",
      "--show-toplevel",
    ]);
    repo = { root: top.trim(), cwd, env: forGit };
  } catch {
    throw new DeferralsError("not inside a git repository");
  }
  const { root } = repo;
  const configPath =
    flags.config === undefined
      ? join(root, DEFAULT_CONFIG)
      : inRepository(root, cwd, flags.config, "--config");
  const mode = modeOf(flags, flags.range ?? (env.DIFF_RANGE || undefined));
  if (mode !== undefined && mode !== "all")
    refuseAlias(repo, configPath, flags.config ?? DEFAULT_CONFIG, mode);
  // A staged change is judged by the configuration the commit holds, never
  // by a working-tree copy beside it: one the index lacks (never added, or
  // its removal staged) is refused.
  if (mode === "staged" && indexedConfig(repo, configPath, mode) === undefined)
    throw new DeferralsError(
      existsSync(configPath)
        ? `configuration ${configPath} is not in the index; --staged judges by the configuration the commit holds, so stage it`
        : `configuration ${configPath} does not exist (see templates/deferral-references.yaml)`,
    );
  if (mode !== "staged" && !existsSync(configPath))
    throw new DeferralsError(
      `configuration ${configPath} does not exist (see templates/deferral-references.yaml)`,
    );
  return {
    repo,
    configPath,
    listKeys: flags.listKeys,
    ...(mode === undefined ? {} : { mode }),
    ...(flags.states === undefined
      ? {}
      : {
          states: {
            name: flags.states,
            path: inRepository(root, cwd, flags.states, "--states"),
          },
        }),
  };
}

/**
 * `path` (relative to `cwd`) resolved, refused unless it lies inside the
 * repository at `root`: a file the command line names is read from the
 * repository the check judges, never from elsewhere on the machine. Both the
 * path as named and the file its links lead to must lie inside, so neither an
 * alias of the working directory nor a link out of the repository decides the
 * answer. The path as named is what is returned: it is the file's identity in
 * the index, which a link in the working tree must not replace.
 */
function inRepository(
  root: string,
  cwd: string,
  path: string,
  flag: string,
): string {
  const inside = realpathSync(root) + sep;
  const named = resolve(realpathSync(cwd), path);
  const linked = existsSync(named) ? realpathSync(named) : named;
  if (!named.startsWith(inside) || !linked.startsWith(inside))
    throw new DeferralsError(
      `${flag} ${path} lies outside the repository ${root}`,
    );
  return named;
}

/**
 * A diff mode knows the configuration by its path in the index: the staged
 * mode reads its copy there, and both diff modes judge every document when
 * that path changes. A path reaching the file through a link (the file
 * itself, or a directory on the way) names nothing the index holds, so the
 * run would read the working tree's copy and miss a change to the real one.
 * Refused, with one exception for the staged mode, which reads the index:
 * when the index tracks the path as named as a regular file, that entry is
 * the configuration, whatever the working tree links there. A range reads the
 * working tree's copy, so a link there is refused whatever the index holds.
 */
function refuseAlias(
  repo: Repo,
  configPath: string,
  named: string,
  mode: Mode,
): void {
  if (!existsSync(configPath)) return;
  const path = relativePath(repo.root, configPath);
  const real = relativePath(realpathSync(repo.root), realpathSync(configPath));
  if (path === real) return;
  const entry = git(repo, [
    "ls-files",
    "-s",
    "-z",
    "--",
    `:(top,literal)${path}`,
  ]);
  if (mode === "staged" && entry.startsWith("100")) return;
  throw new DeferralsError(
    `configuration ${named} is reached through a link; name it by the path the repository tracks it at (${real})`,
  );
}

interface Judged {
  source: Source;
  reading: Reading;
}

/** Print the findings of every document and return how many there were. */
function report(judged: Judged[], states: Map<string, ItemState> | undefined) {
  let failures = 0;
  for (const { source, reading } of judged) {
    const { added } = source;
    const findings =
      states !== undefined
        ? [...reading.findings, ...liveFindings(reading.deferrals, states)]
        : reading.findings.filter(
            (f) => added === undefined || touchedBy(f, added),
          );
    for (const f of findings) console.log(format(source.path, f));
    failures += findings.length;
  }
  return failures;
}

export function run(
  argv: string[],
  env: Env = process.env,
  cwd = process.cwd(),
): number {
  const asked = plan(argv, env, cwd);
  if (asked.mode === undefined) {
    console.log(
      "SKIP: --ci with no range: nothing was compared, so nothing was checked",
    );
    return 0;
  }
  const config = parseConfig(
    configText(asked.repo, asked.configPath, asked.mode),
    asked.configPath,
  );
  const judged = sources(asked.repo, config, asked.mode, asked.configPath).map(
    (source) => ({
      source,
      reading: readDocument(source.content, config),
    }),
  );
  if (asked.listKeys) {
    const keys = judged.flatMap(({ reading }) =>
      reading.deferrals.flatMap((d) => d.keys),
    );
    for (const key of [...new Set(keys)].sort(byCodeUnit)) console.log(key);
    return 0;
  }
  const states =
    asked.states === undefined
      ? undefined
      : parseStates(readFileSync(asked.states.path, "utf8"), asked.states.name);
  const failures = report(judged, states);
  const total = judged.reduce(
    (n, { reading }) => n + reading.deferrals.length,
    0,
  );
  console.log(
    `check-deferrals: ${judged.length} document(s), ${total} deferral(s), ${failures} finding(s)`,
  );
  return failures > 0 ? 1 : 0;
}

/** Whether a change added a line of the block the finding is about. */
function touchedBy(f: Finding, added: Set<number>): boolean {
  for (let n = f.line; n <= f.end; n++) if (added.has(n)) return true;
  return false;
}

if (import.meta.main) cli(() => run(process.argv.slice(2)));
