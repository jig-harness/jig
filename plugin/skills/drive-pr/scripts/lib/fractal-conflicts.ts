/** Merge-conflict coverage of the scoreboard's forge-listed merged PR cohort. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRecord } from "../../../../shared/guards.ts";
import { errnoCode, swallow } from "../../../../shared/errors.ts";
import type { PrSample, Repo } from "./sample.ts";
import type { MetricSpec } from "./fractal-baseline.ts";
import { verdictOf } from "./fractal-baseline.ts";
import {
  gitIsRecentEnough,
  NO_LAZY_FETCH_GIT,
  parseGitVersion,
} from "../../../resolve-conflicts/scripts/lib/replay.ts";
import {
  ghCall,
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  run,
  type RunOptions,
  tsArgv,
} from "./proc.ts";

export type ConflictObservation = "conflicted" | "observed-clean" | "unknown";
export interface ConflictCoverage {
  cohort: number;
  cohortCapped?: boolean;
  conflicted: number;
  observedClean: number;
  unknown: number;
  coverage: number | null;
  share: number | null;
  bounds: { low: number; high: number } | null;
  coverageFloor: number;
}

export function conflictCoverage(
  cohort: readonly number[],
  observations: ReadonlyMap<number, ConflictObservation>,
  coverageFloor: number,
): ConflictCoverage {
  const ids = [...new Set(cohort)];
  const conflicted = ids.filter(
    (id) => observations.get(id) === "conflicted",
  ).length;
  const observedClean = ids.filter(
    (id) => observations.get(id) === "observed-clean",
  ).length;
  const measured = conflicted + observedClean;
  const unknown = ids.length - measured;
  return {
    cohort: ids.length,
    conflicted,
    observedClean,
    unknown,
    coverageFloor,
    coverage: ids.length === 0 ? null : measured / ids.length,
    share: measured === 0 ? null : conflicted / measured,
    bounds:
      ids.length === 0
        ? null
        : {
            low: conflicted / ids.length,
            high: (conflicted + unknown) / ids.length,
          },
  };
}

/** Unknown PRs may be all clean or all conflicted: both endpoints must agree. */
export function judgedConflictShare(
  c: ConflictCoverage,
  specs: readonly MetricSpec[],
): number | null {
  const spec = specs.find((s) => s.id === "merge_conflict_share");
  if (
    c.coverage === null ||
    c.coverage < c.coverageFloor ||
    c.bounds === null ||
    c.cohortCapped === true ||
    spec === undefined
  )
    return null;
  return verdictOf(spec, c.bounds.low) === verdictOf(spec, c.bounds.high)
    ? c.share
    : null;
}

export function renderConflictCoverage(c: ConflictCoverage): string {
  const pct = (n: number | null) =>
    n === null ? "n/a" : `${(100 * n).toFixed(1)}%`;
  return `Merge conflicts: ${c.conflicted} conflicted, ${c.observedClean} observed clean, ${c.unknown} unknown of ${c.cohort} ${c.cohortCapped ? "listed merged PRs (cohort capped)" : "merged PRs"}; coverage ${pct(c.coverage)} (floor ${pct(c.coverageFloor)}). Measured share ${pct(c.share)}; ${c.cohortCapped ? "full cohort bounds unavailable" : `whole-cohort bounds ${pct(c.bounds?.low ?? null)}–${pct(c.bounds?.high ?? null)}`}.`;
}

export const CONFLICT_LIMITS =
  "Conflict evidence covers replayed PR ancestry and this clone's live events. Live silence never proves clean. Force-pushed or unavailable heads remain unknown unless a conflict is recorded. Cherry-pick and revert conflicts resolved in other clones can remain invisible; a clean git merge can still break the build.";

interface LiveEvent {
  type: "merge_conflict";
  ts: string;
  commit: string;
  path: string;
  pr: number | null;
}
interface ReplayEvidence {
  schema: "merge-conflicts/v1";
  shallow: boolean;
  merges: {
    commit: string;
    conflicted: boolean;
    pullRequest: number | null;
    date: string;
  }[];
}
class ConflictEvidenceError extends Error {}
function replayEvidence(value: unknown): value is ReplayEvidence {
  return (
    isRecord(value) &&
    value.schema === "merge-conflicts/v1" &&
    typeof value.shallow === "boolean" &&
    Array.isArray(value.merges) &&
    value.merges.every(
      (m) =>
        isRecord(m) &&
        typeof m.commit === "string" &&
        typeof m.conflicted === "boolean" &&
        typeof m.date === "string" &&
        (m.pullRequest === null || Number.isInteger(m.pullRequest)),
    )
  );
}
function liveEvent(value: unknown): value is LiveEvent {
  return (
    isRecord(value) &&
    value.type === "merge_conflict" &&
    typeof value.ts === "string" &&
    Number.isFinite(Date.parse(value.ts)) &&
    typeof value.commit === "string" &&
    typeof value.path === "string" &&
    (value.pr === null || Number.isInteger(value.pr))
  );
}
export interface ConflictEvidence {
  report: ReplayEvidence | null;
  complete?: boolean;
  events: LiveEvent[];
}

/** The collector is injectable so a failed forge/git probe can never certify clean. */
export interface ConflictDeps {
  evidence(
    samples: readonly PrSample[],
    cohort: readonly CohortPr[],
  ): Promise<ConflictEvidence>;
  ancestry(
    sample: PrSample,
  ): Promise<{ commits: Set<string>; merges: Set<string> } | null>;
  noForcePush(sample: PrSample): Promise<boolean>;
}

type CohortPr = { number: number; mergedAt: string };
type Ancestry = Awaited<ReturnType<ConflictDeps["ancestry"]>>;

/** Direct PR marks remain useful even when its head has disappeared. */
function directlyConflicted(pr: CohortPr, evidence: ConflictEvidence): boolean {
  return (
    evidence.events.some(
      (e) => e.pr === pr.number && Date.parse(e.ts) <= Date.parse(pr.mergedAt),
    ) ||
    (evidence.report?.merges ?? []).some(
      (m) =>
        m.conflicted &&
        m.pullRequest === pr.number &&
        Date.parse(m.date) <= Date.parse(pr.mergedAt),
    )
  );
}

function historyConflicted(
  sample: PrSample,
  ancestry: Ancestry,
  evidence: ConflictEvidence,
): boolean {
  const belongs = (commit: string) =>
    commit === sample.mergeCommitOid || ancestry?.commits.has(commit);
  return (
    evidence.events.some((e) => belongs(e.commit)) ||
    (evidence.report?.merges ?? []).some(
      (m) => m.conflicted && belongs(m.commit),
    )
  );
}

function replayComplete(
  ancestry: Ancestry,
  evidence: ConflictEvidence,
  replayed: ReadonlySet<string>,
): boolean {
  return (
    ancestry !== null &&
    evidence.report !== null &&
    !evidence.report.shallow &&
    evidence.complete !== false &&
    [...ancestry.merges].every((oid) => replayed.has(oid))
  );
}

/** Only this PR's ancestry counts, excluding base and imported branch history. */
async function observeSample(
  sample: PrSample,
  deps: ConflictDeps,
  evidence: ConflictEvidence,
  replayed: ReadonlySet<string>,
  direct: boolean,
): Promise<ConflictObservation> {
  let ancestry: Ancestry = null;
  try {
    ancestry = await deps.ancestry(sample);
  } catch {
    /* An unavailable head is unknown. */
  }
  if (direct || historyConflicted(sample, ancestry, evidence))
    return "conflicted";
  if (!replayComplete(ancestry, evidence, replayed)) return "unknown";
  try {
    return (await deps.noForcePush(sample)) ? "observed-clean" : "unknown";
  } catch {
    /* A failed forge probe cannot certify clean. */ return "unknown";
  }
}

export async function observeConflicts(
  samples: readonly PrSample[],
  deps: ConflictDeps,
  cohort: readonly CohortPr[] = samples
    .filter((s) => s.mergedAt !== null)
    .map((s) => ({ number: s.pr, mergedAt: s.mergedAt as string })),
): Promise<Map<number, ConflictObservation>> {
  const out = new Map<number, ConflictObservation>();
  const evidence = await deps.evidence(samples, cohort);
  const replayed = new Set(
    (evidence.report?.merges ?? []).map((m) => m.commit),
  );
  for (const pr of cohort)
    if (directlyConflicted(pr, evidence)) out.set(pr.number, "conflicted");
  for (const sample of samples)
    out.set(
      sample.pr,
      await observeSample(
        sample,
        deps,
        evidence,
        replayed,
        out.get(sample.pr) === "conflicted",
      ),
    );
  return out;
}

/** GraphQL totalCount ignores itemTypes; inspect the filtered first node. */
export function forgeProvesNoForcePush(body: unknown, head: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const response = body as {
    errors?: unknown;
    data?: {
      repository?: {
        pullRequest?: {
          headRefOid?: unknown;
          timelineItems?: { nodes?: unknown };
        };
      };
    };
  };
  const pr = response.data?.repository?.pullRequest;
  return (
    !response.errors &&
    pr?.headRefOid === head &&
    Array.isArray(pr.timelineItems?.nodes) &&
    pr.timelineItems.nodes.length === 0
  );
}

/**
 * The earliest commit time the cohort's evidence can need: a merge committed
 * before every sampled commit, PR opening and merge is no cohort PR's ancestry.
 * A merge this bound misses leaves its PR unknown, never clean.
 */
export function replaySince(
  samples: readonly PrSample[],
  cohort: readonly CohortPr[],
): string | null {
  const times = [
    ...samples.flatMap((s) => [
      s.createdAt,
      ...s.commits.map((c) => c.committedDate),
    ]),
    ...cohort.map((pr) => pr.mergedAt),
  ]
    .map((t) => Date.parse(t))
    .filter(Number.isFinite);
  return times.length === 0 ? null : new Date(Math.min(...times)).toISOString();
}

/** Before git 2.45 nothing stops a partial clone's `rev-list` from fetching the objects it lacks. */
async function ancestryWillNotFetch(opts: RunOptions): Promise<boolean> {
  const version = await git(["--version"], opts);
  const parsed = version.code === 0 ? parseGitVersion(version.stdout) : null;
  if (parsed !== null && gitIsRecentEnough(parsed, NO_LAZY_FETCH_GIT))
    return true;
  // Any promisor or filter key counts, whatever its value: 1 is "no such key".
  const partial = await git(
    [
      "config",
      "--get-regexp",
      "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$",
    ],
    opts,
  );
  return partial.code === 1;
}

export function realConflictDeps(
  root: string,
  repo: Repo,
  note: (message: string) => void = () => undefined,
): ConflictDeps {
  const gitOpts = {
    cwd: root,
    env: { ...gitIdentityEnv(), GIT_NO_LAZY_FETCH: "1" },
    timeoutSec: gitCallTimeoutSeconds(),
  };
  let fetchSafe: Promise<boolean> | null = null;
  return {
    async evidence(samples, cohort) {
      const since = replaySince(samples, cohort);
      const result = await run(
        tsArgv(
          join(
            import.meta.dir,
            "../../../resolve-conflicts/scripts/history.ts",
          ),
          since === null ? ["--all", "--json"] : ["--since", since, "--json"],
        ),
        { cwd: root, timeoutSec: 600 },
      );
      let report: ReplayEvidence | null = null;
      let complete = true;
      try {
        if (result.code !== 0) throw new ConflictEvidenceError(result.stderr);
        const parsed: unknown = JSON.parse(result.stdout);
        if (!replayEvidence(parsed))
          throw new ConflictEvidenceError("unreadable report");
        report = parsed;
      } catch (err) {
        report = null;
        complete = false;
        note(`merge-conflict replay unavailable: ${err}`);
      }
      const common = await git(["rev-parse", "--git-common-dir"], gitOpts);
      if (common.code !== 0)
        throw new ConflictEvidenceError(
          "cannot locate the clone's live conflict record",
        );
      let events: LiveEvent[] = [];
      try {
        const lines = readFileSync(
          join(
            resolve(root, common.stdout.trim()),
            "jig/conflict-events.jsonl",
          ),
          "utf8",
        );
        events = lines
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => {
            const parsed: unknown = JSON.parse(line);
            if (!liveEvent(parsed))
              throw new ConflictEvidenceError("unreadable live conflict event");
            return parsed;
          });
      } catch (err) {
        if (errnoCode(err) !== "ENOENT") {
          complete = false;
          note(`live conflict events unavailable: ${err}`);
        } else
          swallow(
            err,
            "A clone without a live conflict record has no live evidence.",
          );
      }
      return { report, events, complete };
    },
    async ancestry(sample) {
      if (
        !/^[0-9a-f]{40,64}$/.test(sample.headRefOid) ||
        !/^[0-9a-f]{40,64}$/.test(sample.mergeCommitOid)
      )
        return null;
      fetchSafe ??= ancestryWillNotFetch(gitOpts).then((safe) => {
        if (!safe)
          note(
            "merge-conflict ancestry unavailable: git before 2.45 could fetch in this partial clone",
          );
        return safe;
      });
      if (!(await fetchSafe)) return null;
      const landed = await git(
        ["rev-list", "--parents", "-n", "1", sample.mergeCommitOid],
        gitOpts,
      );
      if (landed.code !== 0) return null;
      const finalParents = landed.stdout.trim().split(" ");
      if (finalParents.length < 2) return null;
      const base = finalParents[1] as string;
      const result = await git(
        [
          "rev-list",
          "--first-parent",
          "--parents",
          sample.headRefOid,
          `^${base}`,
        ],
        gitOpts,
      );
      if (result.code !== 0 || result.stdout.trim() === "") return null;
      const rows = result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split(" "));
      rows.push(finalParents);
      return {
        commits: new Set(rows.map((r) => r[0] as string)),
        merges: new Set(
          rows.filter((r) => r.length > 2).map((r) => r[0] as string),
        ),
      };
    },
    async noForcePush(sample) {
      const query = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){headRefOid timelineItems(first:1,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{__typename}}}}}`;
      const result = await ghCall([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${repo.owner}`,
        "-f",
        `name=${repo.name}`,
        "-F",
        `pr=${sample.pr}`,
      ]);
      if (result.code !== 0) return false;
      try {
        return forgeProvesNoForcePush(
          JSON.parse(result.stdout),
          sample.headRefOid,
        );
      } catch (err) {
        swallow(err, "An unreadable forge timeline cannot certify a clean PR.");
        return false;
      }
    },
  };
}
