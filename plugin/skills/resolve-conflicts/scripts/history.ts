#!/usr/bin/env bun
/**
 * Where a repository's merges conflict, and why: replay every merge commit
 * its refs reach within a range of time, give each conflicting region a
 * cause, and report the paths most often first with the change that removes
 * each cause.
 *
 * Usage: bun history.ts [--days <n> | --since <date> [--until <date>] | --all]
 *                       [--json] [--limit <n>]
 *   --days <n>      the last n days (default 30).
 *   --since <date>  merges committed on or after the date (YYYY-MM-DD, or an
 *                   ISO 8601 time with its offset); --until <date> ends the
 *                   range before that time, or after that day for a bare date.
 *   --all           the whole history.
 *   --json          the report as JSON (schema `merge-conflicts/v1`).
 *   --limit <n>     paths the terminal report lists (default 25; 0: all).
 *
 * Each merge's two parents are merged again with `git merge-tree
 * --write-tree` (diff3 style, so every region carries its merge base). Git's
 * new objects go to a temporary object directory that is removed afterwards:
 * no ref, index, working tree or object of the repository changes. Today's
 * attributes and merge drivers are kept out of the past merges. It reads git
 * only, needs git 2.43 or later, and 2.45 or later in a partial clone. In a
 * shallow clone, a merge whose history the clone cuts is skipped.
 *
 * Reads `resolve_conflicts.generated` and `resolve_conflicts.hotspot_min_merges`
 * from the configuration, and the release step's version files from
 * `changelog.version` (the repository's own `.config/jig.yaml`).
 *
 * Exit codes: 0 the report was printed; 1 a git call failed; 2 usage error,
 * not inside a git repository, invalid configuration, git older than 2.43, or
 * a partial clone with git older than 2.45.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { swallow } from "../../../shared/errors.ts";
import { loadChangelogConfig } from "../../changelog/scripts/config.ts";
import {
  derivedFiles,
  type VersionFile,
  versionSpan,
} from "../../changelog/scripts/versions.ts";
import { prNumber } from "./conflict-map.ts";
import {
  type Cause,
  isMechanical,
  isProse,
  ordered,
  type Region,
  type RegionContext,
  type ReleaseField,
  regionCause,
  type SideName,
} from "./lib/causes.ts";
import {
  type GeneratedEntry,
  generatedEntries,
  hotspotMinMerges,
  type PathClass,
  regenerateFor,
} from "./lib/classify.ts";
import { parseRegionLines } from "./lib/markers.ts";
import {
  type ConflictedPath,
  Git,
  cutByBoundary,
  gitIsRecentEnough,
  isPartialClone,
  mergeBases,
  NO_LAZY_FETCH_GIT,
  shallowBoundary,
  subjectBranches,
  MIN_GIT,
  type MergeCommit,
  mergeCommits,
  markerSizes,
  mergeTree,
  parseGitVersion,
  parseResolutionSection,
  type PullRequestHead,
  pullRequestHeads,
  readObjects,
  withScratchObjects,
} from "./lib/replay.ts";
import {
  buildReport,
  loadConfidence,
  type MergeRecord,
  type PathRecord,
  type Range,
  type RegionRecord,
  renderReport,
  type SkippedMerge,
} from "./lib/report.ts";
import { kindOf } from "./lib/snapshot.ts";

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE =
  "usage: history.ts [--days <n> | --since <date> [--until <date>] | --all] [--json] [--limit <n>]";

export interface Options {
  json: boolean;
  limit: number;
  /** Milliseconds since the epoch; null: open. */
  since: number | null;
  until: number | null;
  label: string;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DATE_ARG =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * A `--since`/`--until` value: `YYYY-MM-DD`, that day's start (UTC), or an
 * ISO 8601 time with its offset (`Z` or `±HH:MM`), so no value depends on the
 * machine's time zone. A day the calendar does not have is refused.
 */
function parseDate(value: string | undefined, end: boolean): number | null {
  if (value === undefined) return null;
  const match = value.match(DATE_ARG);
  if (!match) return null;
  const [, year, month, date] = match.map(Number) as number[];
  // setUTCFullYear, unlike Date.UTC, reads a year below 100 as itself.
  const day = new Date(0);
  day.setUTCFullYear(year as number, (month as number) - 1, date);
  if (
    day.getUTCFullYear() !== year ||
    day.getUTCMonth() + 1 !== month ||
    day.getUTCDate() !== date
  )
    return null;
  const bare = !value.includes("T");
  const ms = Date.parse(bare ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) return null;
  return bare && end ? ms + DAY_MS : ms;
}

function whole(value: string | undefined, min: number): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

interface Flags {
  json: boolean;
  all: boolean;
  limit: number;
  days: number | null;
  since: string | undefined;
  until: string | undefined;
}

/** Each flag that takes a value: how it is stored, or the message for a bad value. */
const VALUE_FLAGS: Record<
  string,
  (flags: Flags, value: string | undefined) => string | null
> = {
  "--days": (flags, value) => {
    flags.days = whole(value, 1);
    return flags.days === null
      ? "--days takes a whole number of 1 or more"
      : null;
  },
  "--limit": (flags, value) => {
    const n = whole(value, 0);
    if (n === null) return "--limit takes a whole number (0 lists every path)";
    flags.limit = n;
    return null;
  },
  "--since": (flags, value) => {
    flags.since = value;
    return parseDate(value, false) === null
      ? "--since takes a date (YYYY-MM-DD) or an ISO 8601 time with its offset"
      : null;
  },
  "--until": (flags, value) => {
    flags.until = value;
    return parseDate(value, true) === null
      ? "--until takes a date (YYYY-MM-DD) or an ISO 8601 time with its offset"
      : null;
  },
};

function readFlags(args: readonly string[]): Flags | string {
  const flags: Flags = {
    json: false,
    all: false,
    limit: DEFAULT_LIMIT,
    days: null,
    since: undefined,
    until: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") flags.json = true;
    else if (arg === "--all") flags.all = true;
    else {
      const store = VALUE_FLAGS[arg];
      const problem = store
        ? store(flags, args[++i])
        : `unknown argument ${arg}`;
      if (problem !== null) return problem;
    }
  }
  return flags;
}

/** The range `--since`/`--until` name, or a usage message. */
function namedRange(
  flags: Flags,
): Pick<Options, "since" | "until" | "label"> | string {
  const from = parseDate(flags.since, false);
  const to = parseDate(flags.until, true);
  if (from !== null && to !== null && from >= to)
    return "--since must be before --until";
  const label =
    to === null
      ? `since ${day(from as number)}`
      : from === null
        ? `until ${day(to - 1)}`
        : `from ${day(from)} to ${day(to - 1)}`;
  return { since: from, until: to, label };
}

/** The command line, or a usage message. */
export function parseArgs(
  args: readonly string[],
  now = Date.now(),
): Options | string {
  const flags = readFlags(args);
  if (typeof flags === "string") return flags;
  const { json, limit } = flags;
  const named = flags.since !== undefined || flags.until !== undefined;
  if ([flags.all, flags.days !== null, named].filter(Boolean).length > 1)
    return "choose one range: --days, --since/--until, or --all";
  if (flags.all)
    return { json, limit, since: null, until: null, label: "all history" };
  if (named) {
    const range = namedRange(flags);
    return typeof range === "string" ? range : { json, limit, ...range };
  }
  const n = flags.days ?? DEFAULT_DAYS;
  const from = now - n * DAY_MS;
  if (Number.isNaN(new Date(from).getTime()))
    return "--days reaches before the earliest date a time can hold";
  return {
    json,
    limit,
    since: from,
    until: null,
    label: `the last ${n} day${n === 1 ? "" : "s"} (${day(from)} to ${day(now)})`,
  };
}

/** The files the release step writes the version into; none when the changelog skill is off. */
function releaseVersionFiles(root: string): VersionFile[] {
  let config: ReturnType<typeof loadChangelogConfig>;
  try {
    config = loadChangelogConfig(root);
  } catch (err) {
    fail(2, `history: ${err instanceof Error ? err.message : err}`);
  }
  if (config === null) return [];
  if (config.version?.kind === "tags") return [];
  if (config.version?.kind === "files") return config.version.files;
  return derivedFiles((path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch (err) {
      swallow(err, `${path} is not readable: it holds no version`);
      return null;
    }
  });
}

interface Setup {
  entries: GeneratedEntry[];
  versionFiles: VersionFile[];
  /** The running git's version, which decides how it reads a marker size. */
  gitVersion: readonly number[];
  heads: Map<string, PullRequestHead[]>;
}

function linesOf(text: string | null): string[] | null {
  if (text === null) return null;
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isBinaryBytes(bytes: Buffer | null): boolean {
  return bytes?.subarray(0, 8000).includes(0) ?? false;
}

/** Net lines `to` adds above each line of `from`, from the hunks of `git diff`. */
function netAboveReader(git: Git, from: string | null, to: string | null) {
  let hunks: { start: number; count: number; net: number }[] | null | undefined;
  return (line: number): number | null => {
    if (from === null || to === null) return null;
    if (hunks === undefined) {
      const r = git.raw([
        "diff",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        from,
        to,
      ]);
      hunks =
        r.code === 0
          ? r.stdout
              .toString("utf8")
              .split("\n")
              .flatMap((l) => {
                const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
                if (!m) return [];
                const count = m[2] === undefined ? 1 : Number(m[2]);
                const added = m[3] === undefined ? 1 : Number(m[3]);
                return [{ start: Number(m[1]), count, net: added - count }];
              })
          : null;
    }
    if (hunks === null) return null;
    let net = 0;
    for (const h of hunks) {
      // A hunk that removes nothing inserts after its start line.
      const above =
        h.count === 0 ? h.start < line : h.start + h.count - 1 < line;
      if (above) net += h.net;
    }
    return net;
  };
}

function regionCauseOf(
  git: Git,
  conflicted: ConflictedPath,
  texts: Record<SideName, string | null>,
  versionFiles: VersionFile[],
) {
  // Every key configured for the path: a file can carry more than one release version.
  const release = (side: SideName): ReleaseField[] => {
    const text = texts[side];
    if (text === null) return [];
    return versionFiles.flatMap((file) => {
      if (file.path !== conflicted.path) return [];
      const span = versionSpan(file, text);
      if (span === null) return [];
      const [from, to] = span;
      const start = text.lastIndexOf("\n", from - 1) + 1;
      const end = text.indexOf("\n", from);
      const line = text.slice(start, end < 0 ? undefined : end);
      return [
        {
          version: text.slice(from, to),
          line: line.replace(/\r$/, ""),
          start: from - start,
          end: to - start,
        },
      ];
    });
  };
  const { base, ours, theirs } = conflicted.stages;
  const above = {
    ours: netAboveReader(git, base?.blob ?? null, ours?.blob ?? null),
    theirs: netAboveReader(git, base?.blob ?? null, theirs?.blob ?? null),
  };
  const ctx: RegionContext = {
    inBase: base !== null,
    file: {
      base: linesOf(texts.base),
      ours: linesOf(texts.ours),
      theirs: linesOf(texts.theirs),
    },
    release: {
      base: release("base"),
      ours: release("ours"),
      theirs: release("theirs"),
    },
    prose: isProse(conflicted.path),
    netAbove: (side, line) => above[side](line),
  };
  return (region: Region) => regionCause(region, ctx);
}

function hasStage(stages: ConflictedPath["stages"]): boolean {
  return stages.base !== null || stages.ours !== null || stages.theirs !== null;
}

/** The record of one conflicted path of a replayed merge. */
function pathRecord(
  git: Git,
  conflicted: ConflictedPath,
  markerSize: number,
  objects: {
    tree: Buffer | null;
    base: Buffer | null;
    ours: Buffer | null;
    theirs: Buffer | null;
  },
  setup: Setup,
): PathRecord {
  const { path, stages } = conflicted;
  const derived = regenerateFor(path, setup.entries);
  const binary =
    [stages.base, stages.ours, stages.theirs].some(
      (s) => s?.mode === "160000",
    ) ||
    conflicted.conflicts.some(
      (t) => t === "binary" || t.startsWith("submodule"),
    ) ||
    [objects.base, objects.ours, objects.theirs].some(isBinaryBytes);
  const cls: PathClass = derived ? derived.class : binary ? "binary" : "text";
  const parsed =
    !binary && objects.tree !== null
      ? parseRegionLines(objects.tree.toString("utf8"), markerSize)
      : [];
  const decode = (b: Buffer | null) => (b === null ? null : b.toString("utf8"));
  const texts = {
    base: decode(objects.base),
    ours: decode(objects.ours),
    theirs: decode(objects.theirs),
  };
  const cause = derived
    ? null
    : regionCauseOf(git, conflicted, texts, setup.versionFiles);
  const regions: RegionRecord[] = parsed.map((r) => ({
    start: r.start,
    end: r.end,
    cause:
      cause === null
        ? "derived"
        : r.base === null
          ? "overlap"
          : cause({ ours: r.ours, base: r.base, theirs: r.theirs }),
    lines: {
      ours: r.ours.length,
      base: r.base?.length ?? 0,
      theirs: r.theirs.length,
    },
  }));
  const causes: Cause[] =
    regions.length > 0
      ? ordered(regions.map((r) => r.cause))
      : [pathLevelCause(conflicted, derived !== null, binary)];
  return {
    path,
    kind: hasStage(stages) ? kindOf(stages) : null,
    conflicts: conflicted.conflicts,
    class: cls,
    causes,
    regions,
    mechanical: causes.every(isMechanical),
    resolution: null,
  };
}

/** Git's kinds of conflict that leave text regions in the file. */
const TEXT_CONFLICTS = new Set(["contents", "add/add"]);

/**
 * The cause of a path with no region read: `derived` for a lockfile or a
 * generated file; `structural` when git reports the conflict without text
 * regions; `overlap` for a text conflict whose regions could not be read,
 * which settles nothing.
 */
function pathLevelCause(
  conflicted: ConflictedPath,
  derived: boolean,
  binary: boolean,
): Cause {
  if (derived) return "derived";
  const textual =
    !binary &&
    conflicted.conflicts.length > 0 &&
    conflicted.conflicts.every((kind) => TEXT_CONFLICTS.has(kind));
  return textual ? "overlap" : "structural";
}

/**
 * Replay one two-parent merge. `unrelated` when its parents share no commit
 * (in a full clone), as the original merge must have allowed.
 */
export function replayMerge(
  git: Git,
  merge: MergeCommit,
  setup: Setup,
  unrelated = false,
): MergeRecord {
  const [ours, theirs] = merge.parents as [string, string];
  const merged = mergeTree(git, ours, theirs, unrelated);
  const specs = merged.paths.flatMap((p) => [
    `${merged.tree}:${p.path}`,
    p.stages.base?.blob ?? "",
    p.stages.ours?.blob ?? "",
    p.stages.theirs?.blob ?? "",
  ]);
  const wanted = specs.filter((spec) => spec !== "");
  const read = readObjects(git, wanted);
  const content = new Map(wanted.map((spec, i) => [spec, read[i] ?? null]));
  const get = (spec: string) =>
    spec === "" ? null : (content.get(spec) ?? null);
  const sections = parseResolutionSection(merge.message);
  const sizes = markerSizes(
    git,
    merged.paths.map((p) => p.path),
    setup.gitVersion,
  );
  const paths = merged.paths
    .map((p) => {
      const record = pathRecord(
        git,
        p,
        sizes.get(p.path) as number,
        {
          tree: get(`${merged.tree}:${p.path}`),
          base: get(p.stages.base?.blob ?? ""),
          ours: get(p.stages.ours?.blob ?? ""),
          theirs: get(p.stages.theirs?.blob ?? ""),
        },
        setup,
      );
      record.resolution = sections.get(p.path) ?? null;
      return record;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const conflictedPaths = new Set(paths.map((p) => p.path));
  // merge-tree's exit status decides: a failed merge whose conflicts no path
  // carries is still a conflicted one.
  const conflicted = !merged.clean || paths.length > 0;
  return {
    operation: "merge",
    commit: merge.commit,
    parents: [ours, theirs],
    date: merge.date,
    subject: merge.subject,
    pullRequest: prNumber(merge.subject),
    branches: subjectBranches(merge.subject),
    parentHeads: {
      ours: setup.heads.get(ours) ?? [],
      theirs: setup.heads.get(theirs) ?? [],
    },
    conflicted,
    mechanical: conflicted
      ? paths.length > 0 && paths.every((p) => p.mechanical)
      : null,
    paths,
    unmatchedResolutions: [...sections]
      .filter(([path]) => !conflictedPaths.has(path))
      .map(([path, resolution]) => ({ path, ...resolution })),
  };
}

function checkGit(git: Git): [number, number, number] {
  let output = "";
  try {
    output = git.text(["--version"]);
  } catch (err) {
    fail(
      2,
      `history: cannot run git: ${err instanceof Error ? err.message : err}`,
    );
  }
  const version = parseGitVersion(output);
  if (version === null || !gitIsRecentEnough(version))
    fail(
      2,
      `history: needs git ${MIN_GIT.join(".")} or later (merge-tree reading GIT_ATTR_SOURCE); found ${output.trim() || "no version"}.`,
    );
  return version as [number, number, number];
}

/** A partial clone fetches the objects it lacks; before git 2.45 nothing stops the replay from doing so. */
function refusePartialClone(git: Git, version: readonly number[]): void {
  if (gitIsRecentEnough(version, NO_LAZY_FETCH_GIT) || !isPartialClone(git))
    return;
  fail(
    2,
    `history: this is a partial clone, and git before ${NO_LAZY_FETCH_GIT.join(".")} would fetch the objects it lacks over the network; the replay reads git only. Use git ${NO_LAZY_FETCH_GIT.join(".")} or later, or a full clone.`,
  );
}

/** Replay every merge of `inRange`, or say why one is skipped. */
function replayAll(
  repo: Git,
  inRange: readonly MergeCommit[],
  setup: Setup,
): { merges: MergeRecord[]; skipped: SkippedMerge[] } {
  const merges: MergeRecord[] = [];
  const skipped: SkippedMerge[] = [];
  const boundary = shallowBoundary(repo);
  withScratchObjects(repo, (git) => {
    for (const merge of inRange) {
      const skip = (reason: SkippedMerge["reason"], detail: string) =>
        skipped.push({
          commit: merge.commit,
          date: merge.date,
          subject: merge.subject,
          reason,
          detail,
        });
      if (merge.parents.length > 2) {
        skip(
          "octopus",
          `${merge.parents.length} parents; merge-tree merges two`,
        );
        continue;
      }
      try {
        const bases = mergeBases(
          git,
          merge.parents[0] as string,
          merge.parents[1] as string,
        );
        if (cutByBoundary(git, merge.parents, bases, boundary)) {
          skip(
            "shallow",
            "the shallow clone's boundary hides history between its parents and their merge base",
          );
          continue;
        }
        merges.push(replayMerge(git, merge, setup, bases.length === 0));
      } catch (err) {
        skip("replay-failed", err instanceof Error ? err.message : String(err));
      }
    }
  });
  return { merges, skipped };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === "string") fail(2, `history: ${options}`, USAGE);
  const repo = new Git(process.cwd());
  const version = checkGit(repo);
  if (repo.raw(["rev-parse", "--git-dir"]).code !== 0)
    fail(2, "history: not inside a git repository.");
  refusePartialClone(repo, version);
  const setup: Setup = {
    entries: generatedEntries(),
    versionFiles: releaseVersionFiles(consumerRoot()),
    gitVersion: version,
    heads: pullRequestHeads(repo),
  };
  const minMerges = hotspotMinMerges();
  const seconds = (ms: number | null) =>
    ms === null ? null : Math.ceil(ms / 1000);
  const inRange = mergeCommits(
    repo,
    seconds(options.since),
    seconds(options.until),
  );
  const shallow = shallowBoundary(repo).size > 0;
  const { merges, skipped } = replayAll(repo, inRange, setup);
  const range: Range = {
    since:
      options.since === null ? null : new Date(options.since).toISOString(),
    until:
      options.until === null ? null : new Date(options.until).toISOString(),
    label: options.label,
  };
  const report = buildReport({
    range,
    hotspotMinMerges: minMerges,
    merges,
    skipped,
    shallow,
    confidence: loadConfidence(),
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report, options.limit));
  return 0;
}

if (import.meta.main) runMain("history", main);
