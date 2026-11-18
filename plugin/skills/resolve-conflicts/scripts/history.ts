#!/usr/bin/env bun
/**
 * Where a repository's merges conflict, and why: replay every merge commit
 * its refs reach within a range of time, give each conflicting region a
 * cause, and report the paths most often first with the change that removes
 * each cause.
 *
 * Usage: bun history.ts [--days <n> | --since <date> [--until <date>] | --all]
 *                       [--json] [--limit <n>] [--propose-serialize]
 *                       [--rates [--out <file>] [--cohort-cache <file>]]
 *   --days <n>      the last n days (default 30).
 *   --since <date>  merges committed on or after the date (YYYY-MM-DD, or an
 *                   ISO 8601 time with its offset); --until <date> ends the
 *                   range before that time, or after that day for a bare date.
 *   --all           the whole history.
 *   --json          the report as JSON (schema `merge-conflicts/v1`).
 *   --limit <n>     paths the terminal report lists (default 25; 0: all).
 *   --propose-serialize
 *                   print, instead of the report, the change areas to mark
 *                   `serialize: true` in the change-area catalog
 *                   (`drive.change_areas_catalog`): those a hotspot lies in
 *                   alone, as the lines a person would add. Nothing is written.
 *   --rates         print, instead of the report, the conflict rates of the
 *                   range (schema `merge-conflict-rates/v1`): for each path,
 *                   how many merged pull requests changed it and how many of
 *                   those met a conflict before they merged. The merged pull
 *                   requests are read from the forge, one listing of the range
 *                   (`lib/cohort.ts`); `--cohort-cache <file>` keeps that
 *                   listing, so the next run lists only what changed since.
 *                   `--out <file>` writes the rates there, whole or not at
 *                   all, instead of printing them.
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
 * not inside a git repository, invalid configuration (with
 * `--propose-serialize`, no change-area catalog configured or one that does
 * not read), git older than 2.43, or a partial clone with git older than 2.45;
 * 3 with `--rates`, the merged pull requests did not read in full (a listing
 * that failed, or one cut at its bound): nothing was written, and a file at
 * `--out` stays as it was.
 */
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot, readConfig } from "../../../shared/consumer.ts";
import {
  type ChangeAreaCatalog,
  loadCatalogFile,
} from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { catalogPathFromOverlay } from "../../do-item/scripts/determine_agent.ts";
import { prNumber } from "./conflict-map.ts";
import { generatedEntries, hotspotMinMerges } from "./lib/classify.ts";
import {
  type PathSetup,
  pathRecord,
  releaseVersionFiles,
} from "./lib/path-record.ts";
import {
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
import { proposeSerialize, renderProposal } from "./lib/propose-serialize.ts";
import { askCohortPage } from "./lib/cohort.ts";
import { ratesSummary, runRates } from "./lib/rates-run.ts";
import {
  buildReport,
  loadConfidence,
  type MergeRecord,
  type Range,
  renderReport,
  type SkippedMerge,
} from "./lib/report.ts";
import {
  currentMs,
  isCalendarDate,
  isoFromMs,
  parseMs,
} from "../../../shared/time.ts";

const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE =
  "usage: history.ts [--days <n> | --since <date> [--until <date>] | --all] [--json] [--limit <n>] [--propose-serialize] [--rates [--out <file>] [--cohort-cache <file>]]";

export interface Options {
  json: boolean;
  limit: number;
  /** Print the areas to serialize instead of the report. */
  proposeSerialize: boolean;
  /** Build the conflict rates instead of the report: where they go, and where the cohort's listing is kept. */
  rates?: { out: string | null; cohortCache: string | null };
  /** Milliseconds since the epoch; null: open. */
  since: number | null;
  until: number | null;
  label: string;
}

function day(ms: number): string {
  return isoFromMs(ms).slice(0, 10);
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
  if (!DATE_ARG.test(value) || !isCalendarDate(value.slice(0, 10))) return null;
  const bare = !value.includes("T");
  const ms = parseMs(bare ? `${value}T00:00:00Z` : value);
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
  proposeSerialize: boolean;
  rates: boolean;
  out: string | undefined;
  cohortCache: string | undefined;
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
  "--out": (flags, value) => {
    flags.out = value;
    return value === undefined || value === "" ? "--out takes a file" : null;
  },
  "--cohort-cache": (flags, value) => {
    flags.cohortCache = value;
    return value === undefined || value === ""
      ? "--cohort-cache takes a file"
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
    proposeSerialize: false,
    rates: false,
    out: undefined,
    cohortCache: undefined,
    limit: DEFAULT_LIMIT,
    days: null,
    since: undefined,
    until: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") flags.json = true;
    else if (arg === "--all") flags.all = true;
    else if (arg === "--propose-serialize") flags.proposeSerialize = true;
    else if (arg === "--rates") flags.rates = true;
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

/** What `--rates` adds to the options, or a usage message. */
function ratesOptions(flags: Flags): Pick<Options, "rates"> | string {
  if (!flags.rates)
    return flags.out !== undefined || flags.cohortCache !== undefined
      ? "--out and --cohort-cache go with --rates"
      : {};
  if (flags.proposeSerialize)
    return "choose one of --rates and --propose-serialize";
  return {
    rates: { out: flags.out ?? null, cohortCache: flags.cohortCache ?? null },
  };
}

/** The command line, or a usage message. */
export function parseArgs(
  args: readonly string[],
  now = currentMs(),
): Options | string {
  const flags = readFlags(args);
  if (typeof flags === "string") return flags;
  const rates = ratesOptions(flags);
  if (typeof rates === "string") return rates;
  const { json, limit } = flags;
  const proposeSerialize = flags.proposeSerialize;
  const named = flags.since !== undefined || flags.until !== undefined;
  if ([flags.all, flags.days !== null, named].filter(Boolean).length > 1)
    return "choose one range: --days, --since/--until, or --all";
  if (flags.all)
    return {
      json,
      limit,
      proposeSerialize,
      ...rates,
      since: null,
      until: null,
      label: "all history",
    };
  if (named) {
    const range = namedRange(flags);
    return typeof range === "string"
      ? range
      : { json, limit, proposeSerialize, ...rates, ...range };
  }
  const n = flags.days ?? DEFAULT_DAYS;
  const from = now - n * DAY_MS;
  // A time holds at most 8.64e15 milliseconds either side of the epoch.
  if (!(Math.abs(from) <= 8.64e15))
    return "--days reaches before the earliest date a time can hold";
  return {
    json,
    limit,
    proposeSerialize,
    ...rates,
    since: from,
    until: null,
    label: `the last ${n} day${n === 1 ? "" : "s"} (${day(from)} to ${day(now)})`,
  };
}

/** The release step's version files; an invalid changelog configuration ends the run. */
function releaseVersions(root: string) {
  try {
    return releaseVersionFiles(root);
  } catch (err) {
    fail(2, `history: ${err instanceof Error ? err.message : err}`);
  }
}

interface Setup extends PathSetup {
  /** The running git's version, which decides how it reads a marker size. */
  gitVersion: readonly number[];
  heads: Map<string, PullRequestHead[]>;
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

/** The configured change-area catalog and its path as configured; a missing or unreadable one ends the run. */
function configuredCatalog(): { catalog: ChangeAreaCatalog; where: string } {
  let path: string | null;
  let config: Record<string, unknown>;
  try {
    config = readConfig();
    path = catalogPathFromOverlay(config);
  } catch (err) {
    return fail(2, `history: ${err instanceof Error ? err.message : err}`);
  }
  if (path === null)
    return fail(
      2,
      "history: --propose-serialize needs the change-area catalog, and drive.change_areas_catalog names none",
    );
  try {
    return {
      catalog: loadCatalogFile(path),
      where: String(
        (config.drive as Record<string, unknown>).change_areas_catalog,
      ),
    };
  } catch (err) {
    return fail(2, `history: ${err instanceof Error ? err.message : err}`);
  }
}

/** `--rates`: the conflict rates of the range, printed or written whole to `--out`; 3 when the cohort did not read in full. */
async function ratesMain(
  repo: Git,
  options: Options,
  rates: NonNullable<Options["rates"]>,
  setup: Setup,
): Promise<number> {
  const result = await runRates({
    git: repo,
    root: process.cwd(),
    range: rangeOf(options),
    since: options.since,
    until: options.until,
    now: currentMs(),
    out: rates.out,
    cachePath: rates.cohortCache,
    ask: askCohortPage(process.cwd()),
    replay: (since, until) => ({
      ...replayAll(repo, mergeCommits(repo, since, until), setup),
      shallow: shallowBoundary(repo).size > 0,
    }),
  });
  if (!result.ok) {
    console.error(`history: ${result.reason}`);
    return result.code;
  }
  if (rates.out === null) process.stdout.write(result.text);
  else console.log(ratesSummary(result.rates, rates.out));
  return 0;
}

function rangeOf(options: Options): Range {
  return {
    since: options.since === null ? null : isoFromMs(options.since),
    until: options.until === null ? null : isoFromMs(options.until),
    label: options.label,
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === "string") fail(2, `history: ${options}`, USAGE);
  const catalog = options.proposeSerialize ? configuredCatalog() : null;
  const repo = new Git(process.cwd());
  const version = checkGit(repo);
  if (repo.raw(["rev-parse", "--git-dir"]).code !== 0)
    fail(2, "history: not inside a git repository.");
  refusePartialClone(repo, version);
  const setup: Setup = {
    entries: generatedEntries(),
    versionFiles: releaseVersions(consumerRoot()),
    gitVersion: version,
    heads: pullRequestHeads(repo),
  };
  if (options.rates !== undefined)
    return ratesMain(repo, options, options.rates, setup);
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
  const range = rangeOf(options);
  const report = buildReport({
    range,
    hotspotMinMerges: minMerges,
    merges,
    skipped,
    shallow,
    confidence: loadConfidence(),
  });
  if (catalog !== null) {
    const proposal = proposeSerialize(
      report.paths,
      catalog.catalog,
      catalog.where,
    );
    console.log(
      options.json
        ? JSON.stringify(proposal, null, 2)
        : renderProposal(proposal, range.label),
    );
  } else if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report, options.limit));
  return 0;
}

if (import.meta.main) runMain("history", main);
